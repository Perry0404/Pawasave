-- ============================================================
-- Migration 007: Harden RPC function auth checks
-- Prevents authenticated users from crediting/debiting wallets
-- they do not own. Service-role calls (auth.uid() IS NULL)
-- are always allowed — webhooks and server-side refunds use
-- the service-role key and must retain full access.
-- ============================================================

-- ──────────────────────────────────────────────────────────
-- credit_wallet: only service role OR the wallet owner
-- ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.credit_wallet(
  p_user_id uuid,
  p_naira_kobo bigint DEFAULT 0,
  p_usdc_micro bigint DEFAULT 0
) RETURNS void AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() != p_user_id THEN
    RAISE EXCEPTION 'credit_wallet: unauthorized';
  END IF;

  UPDATE public.wallets
  SET naira_balance_kobo = naira_balance_kobo + p_naira_kobo,
      usdc_balance_micro = usdc_balance_micro + p_usdc_micro,
      updated_at = now()
  WHERE user_id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ──────────────────────────────────────────────────────────
-- debit_wallet: only service role OR the wallet owner
-- ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.debit_wallet(
  p_user_id uuid,
  p_naira_kobo bigint DEFAULT 0,
  p_usdc_micro bigint DEFAULT 0
) RETURNS boolean AS $$
DECLARE
  w public.wallets%rowtype;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() != p_user_id THEN
    RAISE EXCEPTION 'debit_wallet: unauthorized';
  END IF;

  SELECT * INTO w FROM public.wallets WHERE user_id = p_user_id FOR UPDATE;
  IF w.naira_balance_kobo < p_naira_kobo OR w.usdc_balance_micro < p_usdc_micro THEN
    RETURN false;
  END IF;
  UPDATE public.wallets
  SET naira_balance_kobo = naira_balance_kobo - p_naira_kobo,
      usdc_balance_micro = usdc_balance_micro - p_usdc_micro,
      updated_at = now()
  WHERE user_id = p_user_id;
  RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ──────────────────────────────────────────────────────────
-- save_to_vault: only service role OR the wallet owner
-- ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.save_to_vault(
  p_user_id uuid,
  p_naira_kobo bigint,
  p_usdc_micro bigint
) RETURNS boolean AS $$
DECLARE
  w public.wallets%rowtype;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() != p_user_id THEN
    RAISE EXCEPTION 'save_to_vault: unauthorized';
  END IF;

  SELECT * INTO w FROM public.wallets WHERE user_id = p_user_id FOR UPDATE;
  IF w.naira_balance_kobo < p_naira_kobo THEN
    RETURN false;
  END IF;
  UPDATE public.wallets
  SET naira_balance_kobo = naira_balance_kobo - p_naira_kobo,
      usdc_balance_micro = usdc_balance_micro + p_usdc_micro,
      total_saved_kobo = total_saved_kobo + p_naira_kobo,
      updated_at = now()
  WHERE user_id = p_user_id;
  RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ──────────────────────────────────────────────────────────
-- withdraw_from_vault: only service role OR the wallet owner
-- ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.withdraw_from_vault(
  p_user_id uuid,
  p_naira_kobo bigint,
  p_usdc_micro bigint
) RETURNS boolean AS $$
DECLARE
  w public.wallets%rowtype;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() != p_user_id THEN
    RAISE EXCEPTION 'withdraw_from_vault: unauthorized';
  END IF;

  SELECT * INTO w FROM public.wallets WHERE user_id = p_user_id FOR UPDATE;
  IF w.usdc_balance_micro < p_usdc_micro THEN
    RETURN false;
  END IF;
  UPDATE public.wallets
  SET naira_balance_kobo = naira_balance_kobo + p_naira_kobo,
      usdc_balance_micro = usdc_balance_micro - p_usdc_micro,
      total_withdrawn_kobo = total_withdrawn_kobo + p_naira_kobo,
      updated_at = now()
  WHERE user_id = p_user_id;
  RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ──────────────────────────────────────────────────────────
-- esusu_contribute: must be the contributing user
-- ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.esusu_contribute(
  p_user_id uuid,
  p_group_id uuid,
  p_member_id uuid,
  p_amount_kobo bigint,
  p_cycle int
) RETURNS boolean AS $$
DECLARE
  w public.wallets%rowtype;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() != p_user_id THEN
    RAISE EXCEPTION 'esusu_contribute: unauthorized';
  END IF;

  SELECT * INTO w FROM public.wallets WHERE user_id = p_user_id FOR UPDATE;
  IF w.naira_balance_kobo < p_amount_kobo THEN
    RETURN false;
  END IF;

  UPDATE public.wallets
  SET naira_balance_kobo = naira_balance_kobo - p_amount_kobo, updated_at = now()
  WHERE user_id = p_user_id;

  UPDATE public.esusu_groups
  SET pot_balance_kobo = pot_balance_kobo + (p_amount_kobo * 95 / 100),
      emergency_pot_kobo = emergency_pot_kobo + (p_amount_kobo * 5 / 100)
  WHERE id = p_group_id;

  INSERT INTO public.esusu_contributions (group_id, member_id, cycle_number, amount_kobo)
  VALUES (p_group_id, p_member_id, p_cycle, p_amount_kobo);

  RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ──────────────────────────────────────────────────────────
-- allocate_cngn_pool: only service role OR the wallet owner
-- ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.allocate_cngn_pool(
  p_user_id uuid,
  p_usdc_micro bigint
) RETURNS void AS $$
DECLARE
  v_cngn_portion bigint;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() != p_user_id THEN
    RAISE EXCEPTION 'allocate_cngn_pool: unauthorized';
  END IF;

  v_cngn_portion := floor(p_usdc_micro * 0.90);

  UPDATE public.wallets
  SET cngn_pool_micro = cngn_pool_micro + v_cngn_portion,
      usdc_balance_micro = usdc_balance_micro - v_cngn_portion,
      updated_at = now()
  WHERE user_id = p_user_id
    AND usdc_balance_micro >= v_cngn_portion;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ──────────────────────────────────────────────────────────
-- withdraw_cngn_pool: only service role OR the wallet owner
-- ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.withdraw_cngn_pool(
  p_user_id uuid,
  p_amount_micro bigint
) RETURNS boolean AS $$
DECLARE
  w public.wallets%rowtype;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() != p_user_id THEN
    RAISE EXCEPTION 'withdraw_cngn_pool: unauthorized';
  END IF;

  SELECT * INTO w FROM public.wallets WHERE user_id = p_user_id FOR UPDATE;
  IF w.cngn_pool_micro < p_amount_micro THEN
    RETURN false;
  END IF;

  UPDATE public.wallets
  SET cngn_pool_micro = cngn_pool_micro - p_amount_micro,
      usdc_balance_micro = usdc_balance_micro + p_amount_micro,
      updated_at = now()
  WHERE user_id = p_user_id;

  RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ──────────────────────────────────────────────────────────
-- record_platform_fee: service role OR authenticated user for
-- their own account (fee data is computed server-side)
-- ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.record_platform_fee(
  p_user_id uuid,
  p_reference text,
  p_fee_type text,
  p_gross_kobo bigint,
  p_fee_kobo bigint,
  p_fee_percent numeric
) RETURNS void AS $$
BEGIN
  -- Authenticated users may only record fees for their own user_id
  IF auth.uid() IS NOT NULL AND auth.uid() != p_user_id THEN
    RAISE EXCEPTION 'record_platform_fee: unauthorized';
  END IF;

  INSERT INTO public.platform_fees (
    user_id, transaction_ref, fee_type,
    gross_amount_kobo, fee_amount_kobo, fee_percent
  ) VALUES (
    p_user_id, p_reference, p_fee_type,
    p_gross_kobo, p_fee_kobo, p_fee_percent
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
