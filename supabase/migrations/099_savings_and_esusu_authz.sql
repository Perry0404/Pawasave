-- 099_savings_and_esusu_authz.sql  (run after 098)
--
-- APPLY THIS BEFORE 100. Four money RPCs are executable by any signed-in user and do not
-- check who is calling. One combination of two of them mints cNGN out of nothing.
--
-- THE MINT. lock_savings takes the interest rate and the duration from the caller and
-- writes the resulting projected_interest_micro straight onto the lock. withdraw_lock then
-- pays principal + projected_interest on its non-early branch WITHOUT checking that the lock
-- has matured. So:
--
--   lock_savings(me, 1_000_000, 100, 36500, 999.99)   -- apy_percent is numeric(5,2), so 999.99
--   withdraw_lock(me, <that lock>, false)             -- p_early defaults false; no maturity check
--
-- returns roughly 1000x the principal into cngn_pool_micro, in one round trip, repeatable.
-- Both functions are granted to `authenticated` by 078 group B and neither compares auth.uid()
-- to p_user_id. This is reachable today by anyone with an account.
--
-- THE WALLET DEBIT. 007 gave esusu_contribute an auth.uid() = p_user_id check. 070 rewrote the
-- function for cNGN and dropped it. It is still granted to `authenticated`, still takes
-- p_user_id, and still debits usdc_balance_micro AND cngn_pool_micro. So one user can spend
-- another user's savings into a circle pot, crediting whichever p_member_id they pass.
--
-- THE PAYOUT TRIGGER. process_esusu_payout has no caller check at all, so any signed-in user
-- can force any circle's cycle to settle. The recipient and amount are chosen by the function,
-- so this is a timing hole rather than a theft, but it should not be open.
--
-- THE DISCLOSURE. loan_borrow_limit is SECURITY DEFINER with no caller check, so passing
-- somebody else's uuid returns their collateral and outstanding debt.
--
-- All four fixes narrow behaviour only. Signatures are unchanged, so nothing needs redeploying.
-- The one deliberate behaviour change: lock_savings now IGNORES p_apy and reads the rate from
-- fixed_savings_rates. Callers that passed a rate will get the canonical one instead.
--
-- NOT fixed here, because it needs an ops decision about money already in pots:
-- esusu_contributions has no unique (group_id, member_id, cycle_number) guard, so a
-- double-tapped contribute inflates the pot. 071's header records a live case of one member
-- recording cycle 1 five times. Adding the index now would fail on the existing duplicates.

-- ── lock_savings: the rate is ours, not the caller's ──────────────────────────
-- Signature unchanged so PostgREST callers keep working. p_apy is accepted and discarded.
-- fixed_savings_rates (022) holds EFFECTIVE rates for the whole term, not annualised ones, so
-- the interest is principal x rate and must not be prorated by days/365 the way the old body
-- did. apy_percent keeps the annualised equivalent because that is what the UI shows.
CREATE OR REPLACE FUNCTION public.lock_savings(
  p_user_id uuid,
  p_usdc_micro bigint,
  p_kobo bigint,
  p_duration_days int,
  p_apy numeric
) RETURNS uuid AS $$
DECLARE
  w public.wallets%rowtype;
  v_rate numeric;
  v_annualised numeric;
  v_projected bigint;
  v_lock_id uuid;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'lock_savings: unauthorized';
  END IF;
  IF p_usdc_micro IS NULL OR p_usdc_micro <= 0 THEN
    RAISE EXCEPTION 'lock_savings: amount must be positive';
  END IF;

  -- An exact tier only. get_fixed_savings_rate falls back to the annual rate for anything
  -- past its longest tier, which is what made a 36500-day lock pay 100 years of interest.
  SELECT effective_rate_percent INTO v_rate
  FROM public.fixed_savings_rates WHERE duration_days = p_duration_days;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lock_savings: % days is not an offered term', p_duration_days;
  END IF;

  SELECT * INTO w FROM public.wallets WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'lock_savings: no wallet'; END IF;
  IF w.cngn_pool_micro < p_usdc_micro THEN
    RAISE EXCEPTION 'Insufficient cNGN balance';
  END IF;

  v_projected  := floor(p_usdc_micro::numeric * v_rate / 100.0);
  v_annualised := round(v_rate * 365.0 / p_duration_days, 2);

  UPDATE public.wallets
  SET cngn_pool_micro = cngn_pool_micro - p_usdc_micro,
      updated_at = now()
  WHERE user_id = p_user_id;

  INSERT INTO public.savings_locks (
    user_id, amount_usdc_micro, amount_kobo, apy_percent, duration_days,
    projected_interest_micro, effective_rate_at_creation, unlocks_at
  ) VALUES (
    p_user_id, p_usdc_micro, p_kobo, v_annualised, p_duration_days,
    v_projected, v_rate, now() + (p_duration_days || ' days')::interval
  ) RETURNING id INTO v_lock_id;

  INSERT INTO public.transactions (
    user_id, type, direction, amount_kobo, amount_usdc_micro,
    description, status
  ) VALUES (
    p_user_id, 'save_to_vault', 'debit', p_kobo, p_usdc_micro,
    'Locked cNGN savings for ' || p_duration_days || ' days, ' || v_rate || '% over the term',
    'completed'
  );

  RETURN v_lock_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── withdraw_lock: a lock that has not matured cannot take the matured branch ──
-- 042's body, with a caller check and a maturity gate added. Everything else is unchanged:
-- the pledge guard, the 0.5% early fee charged against principal, the xauto spread booking,
-- and the payout landing in cngn_pool_micro rather than spendable balance.
--
-- The matured-branch ledger description also loses "uUSDC" and a hardcoded "X Auto 50% APY",
-- neither of which was true of a cNGN lock priced from fixed_savings_rates.
CREATE OR REPLACE FUNCTION public.withdraw_lock(
  p_user_id uuid, p_lock_id uuid, p_early boolean DEFAULT false
) RETURNS boolean AS $$
DECLARE
  v_lock public.savings_locks%rowtype; v_payout bigint; v_penalty_kobo bigint := 0;
  v_penalty_micro bigint := 0;
  v_spread_micro bigint := 0; v_xauto_rate numeric := 56.0; v_user_rate numeric := 50.0;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'withdraw_lock: unauthorized';
  END IF;

  SELECT * INTO v_lock FROM public.savings_locks
  WHERE id = p_lock_id AND user_id = p_user_id AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  -- Pledged as loan collateral -> not withdrawable until the loan is cleared.
  IF v_lock.pledged_loan_id IS NOT NULL THEN RETURN false; END IF;

  -- The gate that was missing. Without it, p_early => false paid full projected interest on a
  -- lock created seconds earlier, which is the other half of the mint described at the top.
  IF NOT p_early AND now() < v_lock.unlocks_at THEN
    RAISE EXCEPTION 'withdraw_lock: this lock matures on % — pass p_early to break it', v_lock.unlocks_at;
  END IF;

  IF p_early AND now() < v_lock.unlocks_at THEN
    v_penalty_micro := floor(v_lock.amount_usdc_micro * 0.005);
    v_payout := v_lock.amount_usdc_micro - v_penalty_micro;
    v_penalty_kobo := floor(v_lock.amount_kobo * 0.005);
    UPDATE public.savings_locks SET status = 'early_withdrawn', withdrawn_at = now() WHERE id = p_lock_id;
    IF v_penalty_kobo > 0 THEN
      INSERT INTO public.platform_fees (user_id, transaction_ref, fee_type, gross_amount_kobo, fee_amount_kobo, fee_percent)
      VALUES (p_user_id, p_lock_id::text, 'vault_lock_penalty', v_lock.amount_kobo, v_penalty_kobo, 0.50);
      UPDATE public.platform_settings SET value = (COALESCE(value::bigint, 0) + v_penalty_kobo)::text WHERE key = 'platform_revenue_kobo';
    END IF;
  ELSE
    v_payout := v_lock.amount_usdc_micro + v_lock.projected_interest_micro;
    SELECT COALESCE(value::numeric, 56.0) INTO v_xauto_rate FROM public.platform_settings WHERE key = 'xauto_product_apy_percent';
    SELECT COALESCE(value::numeric, 50.0) INTO v_user_rate  FROM public.platform_settings WHERE key = 'xauto_user_apy_percent';
    v_spread_micro := FLOOR(v_lock.amount_usdc_micro::numeric * ((v_xauto_rate - v_user_rate) / 100.0) * (v_lock.duration_days::numeric / 365.0));
    UPDATE public.savings_locks SET status = 'withdrawn', matured_at = now(), withdrawn_at = now() WHERE id = p_lock_id;
    IF v_spread_micro > 0 THEN
      INSERT INTO public.platform_fees (user_id, transaction_ref, fee_type, gross_amount_kobo, fee_amount_kobo, fee_percent)
      VALUES (p_user_id, p_lock_id::text, 'xauto_spread', v_lock.amount_kobo,
              floor(v_lock.amount_kobo::numeric * ((v_xauto_rate - v_user_rate) / 100.0) * (v_lock.duration_days::numeric / 365.0)), (v_xauto_rate - v_user_rate));
    END IF;
  END IF;

  UPDATE public.wallets SET cngn_pool_micro = cngn_pool_micro + v_payout, updated_at = now() WHERE user_id = p_user_id;
  INSERT INTO public.transactions (user_id, type, direction, amount_kobo, amount_usdc_micro, description, status)
  VALUES (p_user_id, 'vault_withdraw', 'credit', v_lock.amount_kobo, v_payout,
    CASE WHEN p_early THEN 'Early lock withdrawal (principal only)'
         ELSE 'Matured lock withdrawn with ' || v_lock.projected_interest_micro || ' micro interest' END, 'completed');
  RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── esusu_contribute: restore the caller check 007 had and 070 dropped ─────────
-- 070's body verbatim, plus the auth check and a membership check. p_member_id was trusted
-- too: the debit went to p_user_id while the contribution row was credited to whatever member
-- id was passed, so the two have to be tied together.
CREATE OR REPLACE FUNCTION public.esusu_contribute(
  p_user_id uuid, p_group_id uuid, p_member_id uuid, p_amount_kobo bigint, p_cycle int
) RETURNS boolean AS $$
DECLARE
  w public.wallets%rowtype;
  v_need_micro bigint; v_from_pool bigint;
  v_penalty_kobo bigint; v_net_kobo bigint; v_ref text; v_gname text;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'esusu_contribute: unauthorized';
  END IF;
  IF p_amount_kobo IS NULL OR p_amount_kobo <= 0 THEN
    RAISE EXCEPTION 'esusu_contribute: amount must be positive';
  END IF;
  -- The member row being credited must be the paying user's own, in the group being paid.
  IF NOT EXISTS (
    SELECT 1 FROM public.esusu_members
    WHERE id = p_member_id AND group_id = p_group_id AND user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'esusu_contribute: not your membership of this circle';
  END IF;

  v_need_micro := p_amount_kobo * 10000; -- kobo -> cNGN micro (1 NGN = 1 cNGN)
  SELECT * INTO w FROM public.wallets WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF (w.usdc_balance_micro + COALESCE(w.cngn_pool_micro,0)) < v_need_micro THEN RETURN false; END IF;

  IF w.usdc_balance_micro < v_need_micro THEN
    v_from_pool := v_need_micro - w.usdc_balance_micro;
    UPDATE public.wallets SET cngn_pool_micro = cngn_pool_micro - v_from_pool,
                              usdc_balance_micro = usdc_balance_micro + v_from_pool
    WHERE user_id = p_user_id;
  END IF;

  v_penalty_kobo := floor(p_amount_kobo * 0.005);
  v_net_kobo := p_amount_kobo - v_penalty_kobo;
  v_ref := 'esusu_' || p_group_id::text || '_' || p_member_id::text || '_c' || p_cycle::text;
  SELECT name INTO v_gname FROM public.esusu_groups WHERE id = p_group_id;

  UPDATE public.wallets SET usdc_balance_micro = usdc_balance_micro - v_need_micro, updated_at = now()
  WHERE user_id = p_user_id;

  UPDATE public.esusu_groups
  SET pot_balance_kobo   = pot_balance_kobo + floor(v_net_kobo * 95 / 100),
      emergency_pot_kobo  = emergency_pot_kobo + (v_net_kobo - floor(v_net_kobo * 95 / 100))
  WHERE id = p_group_id;

  INSERT INTO public.esusu_contributions (group_id, member_id, cycle_number, amount_kobo)
  VALUES (p_group_id, p_member_id, p_cycle, v_net_kobo);

  UPDATE public.esusu_members SET missed_strikes = 0 WHERE id = p_member_id;

  IF NOT EXISTS (SELECT 1 FROM public.transactions WHERE reference = v_ref) THEN
    INSERT INTO public.transactions (user_id, type, direction, amount_kobo, amount_usdc_micro, description, reference, status)
    VALUES (p_user_id, 'esusu_contribute', 'debit', p_amount_kobo, v_need_micro,
            'Contributed to "' || COALESCE(v_gname,'Ajo') || '" (Cycle ' || p_cycle || ')', v_ref, 'completed');
  END IF;

  IF v_penalty_kobo > 0 THEN
    INSERT INTO public.platform_fees (user_id, transaction_ref, fee_type, gross_amount_kobo, fee_amount_kobo, fee_percent)
    VALUES (p_user_id, v_ref, 'esusu_penalty', p_amount_kobo, v_penalty_kobo, 0.50);
    UPDATE public.platform_settings SET value = (COALESCE(value::bigint,0) + v_penalty_kobo)::text WHERE key = 'platform_revenue_kobo';
  END IF;
  RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── process_esusu_payout: only a member of the circle may trigger a cycle ──────
-- A membership check rather than a revoke, because the browser button in the Next app still
-- calls this and the daily esusu_autodebit cron calls it as service_role, where auth.uid() is
-- null and the check is skipped.
CREATE OR REPLACE FUNCTION public.process_esusu_payout(p_group_id uuid)
RETURNS jsonb AS $$
DECLARE
  v_group public.esusu_groups%rowtype;
  v_member_count int; v_contrib_count int;
  v_recipient public.esusu_members%rowtype;
  v_payout_kobo bigint; v_creator_cut_kobo bigint; v_net_payout_kobo bigint; v_clawback_kobo bigint := 0;
  v_next_cycle int;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.esusu_members WHERE group_id = p_group_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'process_esusu_payout: not a member of this circle';
  END IF;

  SELECT * INTO v_group FROM public.esusu_groups WHERE id = p_group_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','not_found'); END IF;
  IF v_group.status <> 'active' THEN RETURN jsonb_build_object('ok',false,'reason','not_active'); END IF;

  SELECT COUNT(*) INTO v_member_count FROM public.esusu_members WHERE group_id = p_group_id AND NOT removed;
  IF v_member_count = 0 THEN RETURN jsonb_build_object('ok',false,'reason','no_active_members'); END IF;

  SELECT COUNT(DISTINCT ec.member_id) INTO v_contrib_count
  FROM public.esusu_contributions ec
  JOIN public.esusu_members em ON ec.member_id = em.id
  WHERE ec.group_id = p_group_id AND ec.cycle_number = v_group.current_cycle AND NOT em.removed;

  IF v_contrib_count < v_member_count THEN
    RETURN jsonb_build_object('ok',false,'reason','incomplete','contributed',v_contrib_count,'needed',v_member_count);
  END IF;

  SELECT * INTO v_recipient FROM public.esusu_members
  WHERE group_id = p_group_id AND NOT removed AND NOT has_collected
  ORDER BY payout_position LIMIT 1;
  IF NOT FOUND THEN
    UPDATE public.esusu_groups SET pot_balance_kobo = 0, status = 'completed' WHERE id = p_group_id;
    RETURN jsonb_build_object('ok',false,'reason','all_paid','completed',true);
  END IF;

  v_payout_kobo      := v_group.pot_balance_kobo;
  v_next_cycle       := v_group.current_cycle + 1;
  v_creator_cut_kobo := FLOOR(v_payout_kobo * v_group.creator_incentive_percent / 100.0);
  v_net_payout_kobo  := v_payout_kobo - v_creator_cut_kobo;

  IF v_recipient.amount_owed_kobo > 0 THEN
    v_clawback_kobo   := LEAST(v_recipient.amount_owed_kobo, v_net_payout_kobo);
    v_net_payout_kobo := v_net_payout_kobo - v_clawback_kobo;
    UPDATE public.esusu_groups  SET emergency_pot_kobo = emergency_pot_kobo + v_clawback_kobo WHERE id = p_group_id;
    UPDATE public.esusu_members SET amount_owed_kobo   = amount_owed_kobo   - v_clawback_kobo WHERE id = v_recipient.id;
  END IF;

  UPDATE public.wallets SET usdc_balance_micro = usdc_balance_micro + (v_net_payout_kobo * 10000), updated_at = now()
  WHERE user_id = v_recipient.user_id;
  UPDATE public.esusu_members SET has_collected = true WHERE id = v_recipient.id;

  INSERT INTO public.transactions (user_id, type, direction, amount_kobo, amount_usdc_micro, description)
  VALUES (v_recipient.user_id, 'esusu_payout', 'credit', v_net_payout_kobo, (v_net_payout_kobo * 10000),
          'Ajo payout - Cycle ' || v_group.current_cycle || ' of "' || v_group.name || '"');

  IF v_creator_cut_kobo > 0 THEN
    UPDATE public.wallets SET usdc_balance_micro = usdc_balance_micro + (v_creator_cut_kobo * 10000), updated_at = now()
    WHERE user_id = v_group.owner_id;
    INSERT INTO public.transactions (user_id, type, direction, amount_kobo, amount_usdc_micro, description)
    VALUES (v_group.owner_id, 'creator_incentive', 'credit', v_creator_cut_kobo, (v_creator_cut_kobo * 10000),
            format('Creator incentive %.1f%% from "%s" Cycle %s', v_group.creator_incentive_percent, v_group.name, v_group.current_cycle));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.esusu_members WHERE group_id = p_group_id AND NOT removed AND NOT has_collected) THEN
    UPDATE public.esusu_groups SET pot_balance_kobo = 0, current_cycle = v_next_cycle, cycle_started_at = now(), status = 'completed' WHERE id = p_group_id;
  ELSE
    UPDATE public.esusu_groups SET pot_balance_kobo = 0, current_cycle = v_next_cycle, cycle_started_at = now() WHERE id = p_group_id;
  END IF;

  RETURN jsonb_build_object('ok',true,'paid_to',v_recipient.user_id,'amount_kobo',v_net_payout_kobo,
    'creator_cut_kobo',v_creator_cut_kobo,'cycle',v_group.current_cycle,'next_cycle',v_next_cycle,
    'completed',(NOT EXISTS (SELECT 1 FROM public.esusu_members WHERE group_id = p_group_id AND NOT removed AND NOT has_collected)));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── loan_borrow_limit: your own collateral and debt, not anyone else's ─────────
CREATE OR REPLACE FUNCTION public.loan_borrow_limit(p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_ltv_fs   numeric := public._loan_setting('loan_ltv_fixed_savings', 70);
  v_ltv_eq   numeric := public._loan_setting('loan_ltv_equity', 40);
  v_fs       bigint  := 0;
  v_eq       bigint  := 0;
  v_limit    bigint;
  v_has_loan boolean;
  v_debt     bigint  := 0;
  v_loan     public.loans%rowtype;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN RAISE EXCEPTION 'forbidden'; END IF;

  SELECT COALESCE(SUM(amount_usdc_micro), 0) INTO v_fs
  FROM public.savings_locks
  WHERE user_id = p_user_id AND status = 'active' AND pledged_loan_id IS NULL;

  v_eq := public._loan_equity_value(p_user_id);

  v_limit := FLOOR(v_fs * v_ltv_fs / 100.0) + FLOOR(v_eq * v_ltv_eq / 100.0);

  SELECT * INTO v_loan FROM public.loans WHERE user_id = p_user_id AND status = 'active' LIMIT 1;
  v_has_loan := FOUND;
  IF v_has_loan THEN v_debt := v_loan.principal_micro + v_loan.accrued_interest_micro; END IF;

  RETURN jsonb_build_object(
    'fixed_savings_micro',  v_fs,
    'equity_micro',         v_eq,
    'ltv_fixed_savings',    v_ltv_fs,
    'ltv_equity',           v_ltv_eq,
    'borrow_limit_micro',   v_limit,
    'available_micro',      CASE WHEN v_has_loan THEN 0 ELSE v_limit END,
    'has_active_loan',      v_has_loan,
    'current_debt_micro',   v_debt
  );
END;
$$;

-- Grants unchanged from 078 group B. Restated so replacing the bodies cannot silently widen
-- them: CREATE OR REPLACE keeps existing grants, but a future DROP + CREATE would not.
GRANT EXECUTE ON FUNCTION public.lock_savings(uuid,bigint,bigint,int,numeric) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.withdraw_lock(uuid,uuid,boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.esusu_contribute(uuid,uuid,uuid,bigint,int) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.process_esusu_payout(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.loan_borrow_limit(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.lock_savings(uuid,bigint,bigint,int,numeric) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.withdraw_lock(uuid,uuid,boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.esusu_contribute(uuid,uuid,uuid,bigint,int) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.process_esusu_payout(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.loan_borrow_limit(uuid) FROM PUBLIC, anon;
