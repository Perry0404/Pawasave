-- ============================================================
-- Migration 016: Creator incentives for Esusu groups +
--                Flipeet Pay virtual account cost tracking
--
-- A. Adds creator_incentive_percent to esusu_groups (default 0).
--    Creator sets this when creating the group (0–5% range).
-- B. Rewrites process_esusu_payout to:
--    - Deduct creator incentive from pot before paying recipient
--    - Credit creator's naira balance immediately
--    - Log creator incentive as a platform_fees entry for audit
-- C. Adds Flipeet Pay billing settings to platform_settings for
--    KYC ($3.5) and monthly account maintenance ($3.5) cost tracking.
-- ============================================================

-- ── PART A: Add creator_incentive_percent to esusu_groups ────────────────────
ALTER TABLE public.esusu_groups
  ADD COLUMN IF NOT EXISTS creator_incentive_percent numeric NOT NULL DEFAULT 0
    CHECK (creator_incentive_percent >= 0 AND creator_incentive_percent <= 5);

-- ── PART B: transactions type constraint — add creator_incentive ──────────────
ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
ALTER TABLE public.transactions ADD CONSTRAINT transactions_type_check CHECK (type IN (
  'deposit', 'withdrawal', 'save_to_vault', 'vault_withdraw',
  'esusu_contribute', 'esusu_payout', 'emergency_payout',
  'split_auto_save', 'split_auto_esusu',
  'goal_contribute', 'goal_claim',
  'creator_incentive', 'cngn_pool_in'
));

-- ── PART C: platform_fees fee_type — ensure creator_incentive is accepted ─────
-- (platform_fees.fee_type is text — no constraint to update)

-- ── PART D: Rewrite process_esusu_payout with creator incentive deduction ─────
CREATE OR REPLACE FUNCTION public.process_esusu_payout(
  p_group_id uuid
) RETURNS jsonb AS $$
DECLARE
  v_group              public.esusu_groups%rowtype;
  v_member_count       int;
  v_contrib_count      int;
  v_recipient          public.esusu_members%rowtype;
  v_payout_kobo        bigint;
  v_creator_cut_kobo   bigint;
  v_net_payout_kobo    bigint;
  v_payout_pos         int;
  v_next_cycle         int;
BEGIN
  SELECT * INTO v_group FROM public.esusu_groups WHERE id = p_group_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF v_group.status != 'active' THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_active'); END IF;

  SELECT COUNT(*) INTO v_member_count FROM public.esusu_members WHERE group_id = p_group_id;

  SELECT COUNT(DISTINCT ec.member_id) INTO v_contrib_count
  FROM public.esusu_contributions ec
  JOIN public.esusu_members em ON ec.member_id = em.id
  WHERE ec.group_id = p_group_id AND ec.cycle_number = v_group.current_cycle;

  IF v_contrib_count < v_member_count THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'incomplete', 'contributed', v_contrib_count, 'needed', v_member_count);
  END IF;

  v_payout_pos := ((v_group.current_cycle - 1) % v_member_count) + 1;
  SELECT * INTO v_recipient FROM public.esusu_members WHERE group_id = p_group_id AND payout_position = v_payout_pos;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_recipient'); END IF;

  v_payout_kobo      := v_group.pot_balance_kobo;
  v_next_cycle       := v_group.current_cycle + 1;

  -- Creator incentive: deducted from pot before recipient is paid
  v_creator_cut_kobo := FLOOR(v_payout_kobo * v_group.creator_incentive_percent / 100.0);
  v_net_payout_kobo  := v_payout_kobo - v_creator_cut_kobo;

  -- Credit recipient (net of creator cut)
  UPDATE public.wallets
  SET naira_balance_kobo = naira_balance_kobo + v_net_payout_kobo,
      updated_at         = now()
  WHERE user_id = v_recipient.user_id;

  INSERT INTO public.transactions (user_id, type, direction, amount_kobo, description)
  VALUES (
    v_recipient.user_id, 'esusu_payout', 'credit', v_net_payout_kobo,
    'Ajo payout – Cycle ' || v_group.current_cycle || ' of "' || v_group.name || '"'
  );

  -- Pay creator incentive (if any)
  IF v_creator_cut_kobo > 0 THEN
    UPDATE public.wallets
    SET naira_balance_kobo = naira_balance_kobo + v_creator_cut_kobo,
        updated_at         = now()
    WHERE user_id = v_group.owner_id;

    INSERT INTO public.transactions (user_id, type, direction, amount_kobo, description)
    VALUES (
      v_group.owner_id, 'creator_incentive', 'credit', v_creator_cut_kobo,
      format('Creator incentive %.1f%% from "%s" Cycle %s', v_group.creator_incentive_percent, v_group.name, v_group.current_cycle)
    );

    INSERT INTO public.platform_fees (user_id, fee_type, amount_usdc_micro, description)
    VALUES (
      v_group.owner_id, 'creator_incentive', 0,
      format('Creator incentive: %s kobo (%.1f%% of %s kobo) from group "%s" cycle %s',
        v_creator_cut_kobo, v_group.creator_incentive_percent, v_payout_kobo, v_group.name, v_group.current_cycle)
    );
  END IF;

  -- Advance group state
  IF v_next_cycle > v_member_count THEN
    UPDATE public.esusu_groups SET pot_balance_kobo = 0, current_cycle = v_next_cycle, status = 'completed' WHERE id = p_group_id;
  ELSE
    UPDATE public.esusu_groups SET pot_balance_kobo = 0, current_cycle = v_next_cycle WHERE id = p_group_id;
  END IF;

  RETURN jsonb_build_object(
    'ok',                  true,
    'paid_to',             v_recipient.user_id,
    'amount_kobo',         v_net_payout_kobo,
    'creator_cut_kobo',    v_creator_cut_kobo,
    'cycle',               v_group.current_cycle,
    'next_cycle',          v_next_cycle,
    'completed',           (v_next_cycle > v_member_count)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.process_esusu_payout(uuid) TO authenticated, service_role;

-- ── PART E: Flipeet Pay cost tracking in platform_settings ───────────────────
-- These are read-only reference values used by the admin dashboard
-- to track Flipeet billing costs against virtual account revenue.
INSERT INTO public.platform_settings (key, value, description) VALUES
  ('flipeet_kyc_cost_usd_cents',         '350',  'Flipeet KYC fee per account in USD cents ($3.50)'),
  ('flipeet_maintenance_monthly_cents',  '350',  'Flipeet monthly account maintenance fee per account in USD cents ($3.50)'),
  ('flipeet_grace_period_days',          '14',   'Payment grace period before auto-suspension (days)'),
  ('flipeet_min_reserve_accounts',       '50',   'Minimum accounts in starter package')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, description = EXCLUDED.description;
