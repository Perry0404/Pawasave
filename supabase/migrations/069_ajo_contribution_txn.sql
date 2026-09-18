-- 069_ajo_contribution_txn.sql  (paste/run after 068)
-- Ajo/Esusu manual contributions were invisible in transaction history: esusu_contribute
-- and esusu_contribute_crypto debit the wallet / credit the pot and book the 0.5% penalty,
-- but never inserted a `transactions` row — so a user who contributed saw no debit and no
-- record. This adds a 'esusu_contribute' debit transaction to BOTH paths (idempotent on the
-- per-cycle reference). Everything else is unchanged from migration 009.

-- ── naira contribution ────────────────────────────────────────────────────────
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
  v_gname text;
BEGIN
  SELECT * INTO w FROM public.wallets WHERE user_id = p_user_id FOR UPDATE;
  IF w.naira_balance_kobo < p_amount_kobo THEN
    RETURN false;
  END IF;

  v_penalty_kobo := floor(p_amount_kobo * 0.005);
  v_net_kobo := p_amount_kobo - v_penalty_kobo;
  v_ref := 'esusu_' || p_group_id::text || '_' || p_member_id::text || '_c' || p_cycle::text;
  SELECT name INTO v_gname FROM public.esusu_groups WHERE id = p_group_id;

  UPDATE public.wallets
  SET naira_balance_kobo = naira_balance_kobo - p_amount_kobo, updated_at = now()
  WHERE user_id = p_user_id;

  UPDATE public.esusu_groups
  SET pot_balance_kobo = pot_balance_kobo + (v_net_kobo * 95 / 100),
      emergency_pot_kobo = emergency_pot_kobo + (v_net_kobo * 5 / 100)
  WHERE id = p_group_id;

  INSERT INTO public.esusu_contributions (group_id, member_id, cycle_number, amount_kobo)
  VALUES (p_group_id, p_member_id, p_cycle, v_net_kobo);

  -- NEW: show the contribution in transaction history (clearly debited). Skip if a row
  -- with this per-cycle reference already exists (idempotent re-runs / double taps).
  IF NOT EXISTS (SELECT 1 FROM public.transactions WHERE reference = v_ref) THEN
    INSERT INTO public.transactions (user_id, type, direction, amount_kobo, description, reference, status)
    VALUES (p_user_id, 'esusu_contribute', 'debit', p_amount_kobo,
            'Contributed to "' || COALESCE(v_gname, 'Ajo') || '" (Cycle ' || p_cycle || ')', v_ref, 'completed');
  END IF;

  IF v_penalty_kobo > 0 THEN
    INSERT INTO public.platform_fees (user_id, transaction_ref, fee_type, gross_amount_kobo, fee_amount_kobo, fee_percent)
    VALUES (p_user_id, v_ref, 'esusu_penalty', p_amount_kobo, v_penalty_kobo, 0.50);
    UPDATE public.platform_settings
    SET value = (COALESCE(value::bigint, 0) + v_penalty_kobo)::text
    WHERE key = 'platform_revenue_kobo';
  END IF;

  RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── crypto (cNGN) contribution ────────────────────────────────────────────────
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
  v_gname text;
BEGIN
  v_amount_kobo := floor(p_amount_cngn_micro / 10000);
  v_penalty_kobo := floor(v_amount_kobo * 0.005);
  v_net_kobo := v_amount_kobo - v_penalty_kobo;
  v_ref := 'esusu_crypto_' || p_group_id::text || '_' || p_member_id::text || '_c' || p_cycle::text;
  SELECT name INTO v_gname FROM public.esusu_groups WHERE id = p_group_id;

  INSERT INTO public.esusu_crypto_deposits (
    group_id, member_id, user_id, wallet_address, amount_cngn_micro, status
  ) VALUES (
    p_group_id, p_member_id, p_user_id, p_wallet_address, p_amount_cngn_micro, 'confirmed'
  ) RETURNING id INTO v_deposit_id;

  UPDATE public.esusu_groups
  SET pot_balance_kobo = pot_balance_kobo + (v_net_kobo * 95 / 100),
      emergency_pot_kobo = emergency_pot_kobo + (v_net_kobo * 5 / 100)
  WHERE id = p_group_id;

  INSERT INTO public.esusu_contributions (group_id, member_id, cycle_number, amount_kobo)
  VALUES (p_group_id, p_member_id, p_cycle, v_net_kobo);

  IF NOT EXISTS (SELECT 1 FROM public.transactions WHERE reference = v_ref) THEN
    INSERT INTO public.transactions (user_id, type, direction, amount_kobo, amount_usdc_micro, description, reference, status)
    VALUES (p_user_id, 'esusu_contribute', 'debit', v_amount_kobo, p_amount_cngn_micro,
            'Contributed to "' || COALESCE(v_gname, 'Ajo') || '" (Cycle ' || p_cycle || ', cNGN)', v_ref, 'completed');
  END IF;

  IF v_penalty_kobo > 0 THEN
    INSERT INTO public.platform_fees (user_id, transaction_ref, fee_type, gross_amount_kobo, fee_amount_kobo, fee_percent)
    VALUES (p_user_id, v_ref, 'esusu_penalty', v_amount_kobo, v_penalty_kobo, 0.50);
    UPDATE public.platform_settings
    SET value = (COALESCE(value::bigint, 0) + v_penalty_kobo)::text
    WHERE key = 'platform_revenue_kobo';
  END IF;

  RETURN v_deposit_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
