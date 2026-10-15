-- 118: In-app account deletion (Google Play and App Store requirement).
--
-- A user can delete their account from Profile, or request it at /delete-account.
--
-- We do NOT delete the auth user or the profile row. profiles references auth.users ON DELETE
-- CASCADE, and transactions, loans, savings and KYC records hang off profiles, so a hard delete
-- would wipe financial records that AML rules require us to keep (at least six years). Instead:
--   • the account must be empty first (account_deletion_blockers lists what is still open);
--   • delete_account anonymises the profile and marks it deleted;
--   • the API route then retires the login (email replaced, user banned) via the auth admin API.
-- The privacy policy already states that records required by law are retained.
--
-- Both functions are service-role only.

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS deletion_reason TEXT;

-- What still has to be closed, withdrawn or settled before the account can go. Empty = clear.
CREATE OR REPLACE FUNCTION public.account_deletion_blockers(p_user_id UUID)
RETURNS TEXT[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_out TEXT[] := ARRAY[]::TEXT[];
BEGIN
  -- Anything above ₦1 still in the wallet (naira ledger, cNGN, USDC).
  IF EXISTS (
    SELECT 1 FROM wallets
     WHERE user_id = p_user_id
       AND (naira_balance_kobo >= 100 OR cngn_pool_micro >= 1000000 OR usdc_balance_micro >= 10000)
  ) THEN
    v_out := array_append(v_out, 'Withdraw your wallet balance'::text);
  END IF;

  IF EXISTS (
    SELECT 1 FROM savings_goals
     WHERE user_id = p_user_id AND status = 'active'
       AND (saved_naira_kobo > 0 OR saved_usdc_micro > 0)
  ) THEN
    v_out := array_append(v_out, 'Withdraw or close your savings goals'::text);
  END IF;

  IF EXISTS (SELECT 1 FROM savings_locks WHERE user_id = p_user_id AND status IN ('active', 'matured')) THEN
    v_out := array_append(v_out, 'Withdraw your locked savings'::text);
  END IF;

  IF EXISTS (SELECT 1 FROM loans WHERE user_id = p_user_id AND status = 'active') THEN
    v_out := array_append(v_out, 'Repay your loan'::text);
  END IF;

  IF EXISTS (
    SELECT 1 FROM esusu_members m JOIN esusu_groups g ON g.id = m.group_id
     WHERE m.user_id = p_user_id AND g.status IN ('forming', 'active')
  ) THEN
    v_out := array_append(v_out, 'Leave or finish your Ajo circles'::text);
  END IF;

  IF EXISTS (SELECT 1 FROM coop_members WHERE user_id = p_user_id AND status = 'active') THEN
    v_out := array_append(v_out, 'Leave your cooperatives'::text);
  END IF;

  IF EXISTS (SELECT 1 FROM portfolio_holdings WHERE user_id = p_user_id AND shares > 0) THEN
    v_out := array_append(v_out, 'Sell your investments'::text);
  END IF;

  IF EXISTS (SELECT 1 FROM flexible_pool_positions WHERE user_id = p_user_id AND cngn_deposited_micro > 0) THEN
    v_out := array_append(v_out, 'Withdraw from the flexible savings pool'::text);
  END IF;

  IF EXISTS (SELECT 1 FROM p2p_transfers WHERE sender_id = p_user_id AND status = 'pending') THEN
    v_out := array_append(v_out, 'Cancel or wait for your unclaimed transfers'::text);
  END IF;

  IF EXISTS (
    SELECT 1 FROM pawa_orders
     WHERE (seller_id = p_user_id OR buyer_id = p_user_id) AND status IN ('paid', 'disputed')
  ) THEN
    v_out := array_append(v_out, 'Finish your open Pay with Pawa orders'::text);
  END IF;

  RETURN v_out;
END;
$$;

-- Anonymise and mark deleted. Idempotent: a second call on a deleted profile is a no-op.
CREATE OR REPLACE FUNCTION public.delete_account(p_user_id UUID, p_reason TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted TIMESTAMPTZ;
  v_blockers TEXT[];
BEGIN
  SELECT deleted_at INTO v_deleted FROM profiles WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile not found';
  END IF;
  IF v_deleted IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'already', true);
  END IF;

  v_blockers := account_deletion_blockers(p_user_id);
  IF array_length(v_blockers, 1) > 0 THEN
    RAISE EXCEPTION 'account not empty: %', array_to_string(v_blockers, '; ');
  END IF;

  UPDATE profiles
     SET display_name = 'Deleted user',
         phone = NULL,
         tag = NULL,
         transaction_pin_hash = NULL,
         deleted_at = now(),
         deletion_reason = left(p_reason, 300)
   WHERE id = p_user_id;

  -- Nothing should reach a deleted account's devices.
  DELETE FROM push_subscriptions WHERE user_id = p_user_id;

  RETURN jsonb_build_object('ok', true, 'already', false);
END;
$$;

REVOKE ALL ON FUNCTION public.account_deletion_blockers(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.delete_account(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_deletion_blockers(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.delete_account(UUID, TEXT) TO service_role;
