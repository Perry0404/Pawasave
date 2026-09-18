-- 067_atomic_strails_credit.sql
-- Make Strails naira-deposit crediting ATOMIC (all-or-nothing), fixing a silent
-- money-loss bug.
--
-- Bug: both the webhook (strails-webhook) and the reconciler (strails-reconcile)
-- credited a deposit in TWO separate calls —
--     1) INSERT a 'completed' transactions row keyed on the Strails reference
--     2) rpc('credit_wallet', ...) to actually add the balance
-- The reference is the idempotency key. If anything interrupted between (1) and (2)
-- — credit_wallet raising (e.g. a brand-new user with no wallets row), the 30s
-- function timing out, or the container restarting — the row said "completed" but
-- the wallet was never credited, and every future webhook/reconcile run saw the
-- reference already present and SKIPPED forever. The user was permanently short a
-- real deposit. (The crypto path never had this — credit_crypto_deposit does it all
-- in one function; this brings Strails to parity.)
--
-- Fix: one SECURITY DEFINER function that does idempotency-check + transactions
-- INSERT + wallet credit + fee booking in a single transaction. A transaction-scoped
-- advisory lock on the reference serialises concurrent webhook/cron runs so they
-- can't both pass the "already seen?" check and double-credit (transactions.reference
-- has no unique constraint, so we lock instead of relying on one). Returns TRUE only
-- when it actually credited (caller then sends push/email), FALSE if already processed.

CREATE OR REPLACE FUNCTION public.credit_strails_deposit(
  p_user_id     uuid,
  p_reference   text,
  p_gross_kobo  bigint,   -- gross NGN received into the NUBAN (×100)
  p_net_micro   bigint,   -- net cNGN credited to the wallet (×1e6), after our fee
  p_fee_kobo    bigint,   -- our platform fee (×100); 0 if none
  p_fee_percent numeric,
  p_description text,
  p_metadata    jsonb DEFAULT '{}'::jsonb
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF p_reference IS NULL OR p_reference = '' THEN
    RAISE EXCEPTION 'credit_strails_deposit: reference required';
  END IF;
  IF p_net_micro <= 0 THEN
    RETURN false;
  END IF;

  -- Serialise concurrent runs for the SAME reference (auto-released at tx end).
  PERFORM pg_advisory_xact_lock(hashtext('strails_credit:' || p_reference));

  -- Idempotency: already credited by an earlier webhook/cron run?
  IF EXISTS (SELECT 1 FROM public.transactions WHERE reference = p_reference) THEN
    RETURN false;
  END IF;

  -- (1) Ledger row. (2) Wallet credit. Both in THIS transaction — if either fails
  -- the whole thing rolls back and the reference is NOT consumed, so a retry works.
  INSERT INTO public.transactions (
    user_id, type, direction, amount_kobo, amount_usdc_micro,
    platform_fee_kobo, description, reference, status, metadata
  ) VALUES (
    p_user_id, 'deposit', 'credit', p_gross_kobo, p_net_micro,
    GREATEST(p_fee_kobo, 0), p_description, p_reference, 'completed', COALESCE(p_metadata, '{}'::jsonb)
  );

  -- Upsert the balance so a missing wallets row (new user) can't abort the credit.
  INSERT INTO public.wallets (user_id, usdc_balance_micro)
  VALUES (p_user_id, p_net_micro)
  ON CONFLICT (user_id) DO UPDATE
    SET usdc_balance_micro = public.wallets.usdc_balance_micro + p_net_micro,
        updated_at = now();

  -- Fee booking is best-effort: a fee failure must NOT roll back the credit
  -- (mirrors the old caller's try/catch). Nested block swallows any fee error.
  IF p_fee_kobo > 0 THEN
    BEGIN
      INSERT INTO public.platform_fees (user_id, transaction_ref, fee_type, gross_amount_kobo, fee_amount_kobo, fee_percent)
      VALUES (p_user_id, p_reference, 'ramp_onramp', p_gross_kobo, p_fee_kobo, p_fee_percent);
      UPDATE public.platform_settings
      SET value = (COALESCE(value::bigint, 0) + p_fee_kobo)::text
      WHERE key = 'platform_revenue_kobo';
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'credit_strails_deposit: fee booking skipped for %: %', p_reference, SQLERRM;
    END;
  END IF;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.credit_strails_deposit(uuid, text, bigint, bigint, bigint, numeric, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.credit_strails_deposit(uuid, text, bigint, bigint, bigint, numeric, text, jsonb) TO service_role;
