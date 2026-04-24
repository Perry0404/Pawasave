-- ============================================================
-- Migration 009: Esusu/Ajo Penalty Revenue
--
-- Adds 0.5% platform penalty on Esusu contributions and ensures
-- penalties are counted in platform revenue and admin summaries.
-- ============================================================

-- Expand fee types to include admin payout logs + esusu penalty
ALTER TABLE public.platform_fees
  DROP CONSTRAINT IF EXISTS platform_fees_fee_type_check;

ALTER TABLE public.platform_fees
  ADD CONSTRAINT platform_fees_fee_type_check
  CHECK (fee_type IN (
    'ramp_onramp',
    'ramp_offramp',
    'vault_lock_penalty',
    'admin_revenue_withdrawal',
    'esusu_penalty'
  ));

-- Esusu naira contribution: 0.5% platform penalty
CREATE OR REPLACE FUNCTION public.esusu_contribute(
  p_user_id uuid,
  p_group_id uuid,
  p_member_id uuid,
  p_amount_kobo bigint,
  p_cycle int
) RETURNS boolean AS $$
DECLARE
  w public.wallets%rowtype;
  v_penalty_kobo bigint;
  v_net_kobo bigint;
  v_ref text;
BEGIN
  SELECT * INTO w FROM public.wallets WHERE user_id = p_user_id FOR UPDATE;
  IF w.naira_balance_kobo < p_amount_kobo THEN
    RETURN false;
  END IF;

  v_penalty_kobo := floor(p_amount_kobo * 0.005);
  v_net_kobo := p_amount_kobo - v_penalty_kobo;
  v_ref := 'esusu_' || p_group_id::text || '_' || p_member_id::text || '_c' || p_cycle::text;

  -- Debit user full contribution
  UPDATE public.wallets
  SET naira_balance_kobo = naira_balance_kobo - p_amount_kobo,
      updated_at = now()
  WHERE user_id = p_user_id;

  -- Credit group pot from net amount (5% of net to emergency)
  UPDATE public.esusu_groups
  SET pot_balance_kobo = pot_balance_kobo + (v_net_kobo * 95 / 100),
      emergency_pot_kobo = emergency_pot_kobo + (v_net_kobo * 5 / 100)
  WHERE id = p_group_id;

  INSERT INTO public.esusu_contributions (group_id, member_id, cycle_number, amount_kobo)
  VALUES (p_group_id, p_member_id, p_cycle, v_net_kobo);

  IF v_penalty_kobo > 0 THEN
    INSERT INTO public.platform_fees (
      user_id, transaction_ref, fee_type, gross_amount_kobo, fee_amount_kobo, fee_percent
    ) VALUES (
      p_user_id, v_ref, 'esusu_penalty', p_amount_kobo, v_penalty_kobo, 0.50
    );

    UPDATE public.platform_settings
    SET value = (COALESCE(value::bigint, 0) + v_penalty_kobo)::text
    WHERE key = 'platform_revenue_kobo';
  END IF;

  RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Esusu crypto contribution: 0.5% platform penalty
CREATE OR REPLACE FUNCTION public.esusu_contribute_crypto(
  p_user_id uuid,
  p_group_id uuid,
  p_member_id uuid,
  p_amount_cngn_micro bigint,
  p_cycle int,
  p_wallet_address text
) RETURNS uuid AS $$
DECLARE
  v_amount_kobo bigint;
  v_penalty_kobo bigint;
  v_net_kobo bigint;
  v_deposit_id uuid;
  v_ref text;
BEGIN
  -- 1 cNGN = 1 NGN; micro/1e6 * 100 = micro/10000
  v_amount_kobo := floor(p_amount_cngn_micro / 10000);
  v_penalty_kobo := floor(v_amount_kobo * 0.005);
  v_net_kobo := v_amount_kobo - v_penalty_kobo;
  v_ref := 'esusu_crypto_' || p_group_id::text || '_' || p_member_id::text || '_c' || p_cycle::text;

  INSERT INTO public.esusu_crypto_deposits (
    group_id, member_id, user_id, wallet_address, amount_cngn_micro, status
  ) VALUES (
    p_group_id, p_member_id, p_user_id, p_wallet_address, p_amount_cngn_micro, 'confirmed'
  ) RETURNING id INTO v_deposit_id;

  -- Credit group pot from net amount
  UPDATE public.esusu_groups
  SET pot_balance_kobo = pot_balance_kobo + (v_net_kobo * 95 / 100),
      emergency_pot_kobo = emergency_pot_kobo + (v_net_kobo * 5 / 100)
  WHERE id = p_group_id;

  INSERT INTO public.esusu_contributions (group_id, member_id, cycle_number, amount_kobo)
  VALUES (p_group_id, p_member_id, p_cycle, v_net_kobo);

  IF v_penalty_kobo > 0 THEN
    INSERT INTO public.platform_fees (
      user_id, transaction_ref, fee_type, gross_amount_kobo, fee_amount_kobo, fee_percent
    ) VALUES (
      p_user_id, v_ref, 'esusu_penalty', v_amount_kobo, v_penalty_kobo, 0.50
    );

    UPDATE public.platform_settings
    SET value = (COALESCE(value::bigint, 0) + v_penalty_kobo)::text
    WHERE key = 'platform_revenue_kobo';
  END IF;

  RETURN v_deposit_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Admin summary: include esusu penalties in penalty bucket
CREATE OR REPLACE FUNCTION public.admin_fee_summary()
RETURNS TABLE (
  total_fees_kobo bigint,
  total_onramp_fees bigint,
  total_offramp_fees bigint,
  total_penalty_fees bigint,
  fee_count bigint,
  today_fees_kobo bigint,
  this_month_fees_kobo bigint
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    COALESCE(SUM(fee_amount_kobo), 0),
    COALESCE(SUM(CASE WHEN fee_type = 'ramp_onramp'  THEN fee_amount_kobo ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN fee_type = 'ramp_offramp' THEN fee_amount_kobo ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN fee_type IN ('vault_lock_penalty', 'esusu_penalty') THEN fee_amount_kobo ELSE 0 END), 0),
    COUNT(*)::bigint,
    COALESCE(SUM(CASE WHEN created_at::date = current_date THEN fee_amount_kobo ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN date_trunc('month', created_at) = date_trunc('month', current_date) THEN fee_amount_kobo ELSE 0 END), 0)
  FROM public.platform_fees
  WHERE fee_amount_kobo > 0;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
