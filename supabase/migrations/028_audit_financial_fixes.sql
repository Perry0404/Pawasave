-- 028_audit_financial_fixes.sql
-- Security audit remediation — financial logic (FIND-FIN-04/05/06).
-- Idempotent: safe to run more than once.

-- ──────────────────────────────────────────────────────────────────────────
-- FIND-FIN-04 — Atomic vault withdrawal (removes the client-side TOCTOU race).
-- The old client flow read the balance, then called withdraw_cngn_pool, then
-- withdraw_from_vault as three separate round-trips. This single RPC does the
-- availability check (free USDC + cNGN pool) and the debit in ONE transaction
-- under a row lock, so two concurrent withdrawals can't double-spend.
-- ──────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.withdraw_vault_atomic(
  p_user_id    uuid,
  p_naira_kobo bigint,
  p_usdc_micro bigint
) RETURNS boolean AS $$
DECLARE
  w           public.wallets%rowtype;
  v_from_pool bigint;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() != p_user_id THEN
    RAISE EXCEPTION 'withdraw_vault_atomic: unauthorized';
  END IF;

  SELECT * INTO w FROM public.wallets WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- Single availability check across free USDC + the cNGN pool.
  IF (w.usdc_balance_micro + w.cngn_pool_micro) < p_usdc_micro THEN
    RETURN false;
  END IF;

  -- Pull from the cNGN pool only if free USDC is short.
  IF w.usdc_balance_micro < p_usdc_micro THEN
    v_from_pool := p_usdc_micro - w.usdc_balance_micro;
    UPDATE public.wallets
    SET cngn_pool_micro    = cngn_pool_micro - v_from_pool,
        usdc_balance_micro = usdc_balance_micro + v_from_pool
    WHERE user_id = p_user_id;
  END IF;

  UPDATE public.wallets
  SET naira_balance_kobo   = naira_balance_kobo + p_naira_kobo,
      usdc_balance_micro   = usdc_balance_micro - p_usdc_micro,
      total_withdrawn_kobo = total_withdrawn_kobo + p_naira_kobo,
      updated_at = now()
  WHERE user_id = p_user_id;

  RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.withdraw_vault_atomic(uuid, bigint, bigint)
  TO authenticated, service_role;

-- ──────────────────────────────────────────────────────────────────────────
-- FIND-FIN-05 — Atomic debit + fee recording. Debiting the user and writing
-- the platform fee in one transaction prevents a half-applied ledger if the
-- process dies between the two calls.
-- ──────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.debit_wallet_with_fee(
  p_user_id     uuid,
  p_naira_kobo  bigint,
  p_usdc_micro  bigint,
  p_reference   text,
  p_fee_type    text,
  p_gross_kobo  bigint,
  p_fee_kobo    bigint,
  p_fee_percent numeric
) RETURNS boolean AS $$
DECLARE
  w public.wallets%rowtype;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() != p_user_id THEN
    RAISE EXCEPTION 'debit_wallet_with_fee: unauthorized';
  END IF;

  SELECT * INTO w FROM public.wallets WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF w.naira_balance_kobo < p_naira_kobo OR w.usdc_balance_micro < p_usdc_micro THEN
    RETURN false;
  END IF;

  UPDATE public.wallets
  SET naira_balance_kobo = naira_balance_kobo - p_naira_kobo,
      usdc_balance_micro = usdc_balance_micro - p_usdc_micro,
      updated_at = now()
  WHERE user_id = p_user_id;

  IF p_fee_kobo > 0 THEN
    INSERT INTO public.platform_fees (
      user_id, transaction_ref, fee_type, gross_amount_kobo, fee_amount_kobo, fee_percent
    ) VALUES (
      p_user_id, p_reference, p_fee_type, p_gross_kobo, p_fee_kobo, p_fee_percent
    );
  END IF;

  RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.debit_wallet_with_fee(uuid, bigint, bigint, text, text, bigint, bigint, numeric)
  TO authenticated, service_role;

-- ──────────────────────────────────────────────────────────────────────────
-- FIND-FIN-06 — Single source of truth for APY values. The frontend currently
-- hardcodes (and disagrees on) flexible/fixed APYs. Store them in
-- platform_settings and expose get_apy_settings() so the app can read one
-- canonical set at runtime.
-- NOTE: the *value* of flexible_apy_percent should track the real pool APY
-- (see the yield discussion) — this migration only centralises it.
-- ──────────────────────────────────────────────────────────────────────────
INSERT INTO public.platform_settings (key, value) VALUES
  ('flexible_apy_percent', '27')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.get_apy_settings()
RETURNS jsonb AS $$
DECLARE result jsonb;
BEGIN
  SELECT jsonb_object_agg(key, value) INTO result
  FROM public.platform_settings
  WHERE key IN (
    'flexible_apy_percent',
    'xauto_user_apy_percent',
    'mm_user_apy_percent',
    'cngn_pool_apy_percent'
  );
  RETURN COALESCE(result, '{}'::jsonb);
END;
$$ LANGUAGE plpgsql STABLE;

GRANT EXECUTE ON FUNCTION public.get_apy_settings() TO anon, authenticated, service_role;