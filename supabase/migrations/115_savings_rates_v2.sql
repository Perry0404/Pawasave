-- 115_savings_rates_v2.sql  (run after 114)
-- Savings rates backed by real yield: Ajo 10.5%, Goals 12%, Fixed 20% (gated).
--
-- MODEL (founder, 2026-10-04): every naira in Goals and Ajo is user money, and it is put
-- to work 1:1. The savings-gntb-sync job keeps custody's gNTB (GetEquity T-bill fund,
-- ~14.5%, 0% fee, redeemable at NAV) equal to the money in active Goals + Ajo pots: it buys
-- on deposit and sells on payout. No buffer. While that position exists the job sets
-- yield_backing_apy_percent to gNTB's live rate; while it is 0, nothing below pays interest.
--
-- HOW INTEREST IS ACCOUNTED (not "rate x elapsed days", which 106 rightly rejected and
-- which is gameable: park N1 in a goal for a year, top up N1M the day before completing,
-- collect a year's interest on N1M):
--   * Goals: accrue_goal_interest() runs daily and adds one day of interest on the goal's
--     ACTUAL balance to interest_earned_micro. Completion pays principal + that figure.
--     Breaking early forfeits it (071 already zeroes it). The day's spread (backing - user
--     rate) is booked as revenue as it accrues.
--   * Ajo and every other circle: accrue_circle_interest() runs daily and adds one day of
--     interest on the pot's ACTUAL balance to esusu_groups.interest_accrued_micro, booking
--     our spread the same day. The interest rides with the pot: process_esusu_payout() pays
--     pot + interest to that cycle's recipient, circle_settle() pays it to the beneficiary.
--     So with daily Ajo the pot earns for the day it sits, with weekly Ajo for the week; the
--     member who collects gets contributions + interest, and our cut came in as it earned.
--     This replaces /api/esusu/yield, whose deposit call trusted a browser-supplied amount
--     and whose payout call let the caller pick the recipient.
--
-- FIXED SAVINGS: 20% a year, gated by fixed_savings_enabled until GetEquity's CP / credit
-- fund (~23%) is live; gNTB alone cannot fund 20%.

-- ── 1. Settings ───────────────────────────────────────────────────────────────
INSERT INTO public.platform_settings (key, value) VALUES
  ('ajo_user_apy_percent',   '10.5'),
  ('goals_user_apy_percent', '12'),
  ('fixed_user_apy_percent', '20'),
  ('fixed_savings_enabled',  'false')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- Written by the sync job, so a re-run of this migration must not reset it.
INSERT INTO public.platform_settings (key, value) VALUES
  ('yield_backing_apy_percent',       '0'),
  ('goal_interest_last_accrued_on',   '1970-01-01'),
  ('circle_interest_last_accrued_on', '1970-01-01')
ON CONFLICT (key) DO NOTHING;

-- Interest a circle's pot has earned and not yet paid out (cNGN micro).
ALTER TABLE public.esusu_groups
  ADD COLUMN IF NOT EXISTS interest_accrued_micro BIGINT NOT NULL DEFAULT 0;

-- ── 2a. Goals: daily accrual on the actual balance ────────────────────────────
-- Idempotent per calendar day (UTC): a second call the same day does nothing.
CREATE OR REPLACE FUNCTION public.accrue_goal_interest()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_today     date    := (now() AT TIME ZONE 'utc')::date;
  v_last      date    := COALESCE((SELECT value::date FROM public.platform_settings WHERE key = 'goal_interest_last_accrued_on'), '1970-01-01');
  v_rate      numeric := COALESCE((SELECT value::numeric FROM public.platform_settings WHERE key = 'goals_user_apy_percent'), 12);
  v_backing   numeric := COALESCE((SELECT value::numeric FROM public.platform_settings WHERE key = 'yield_backing_apy_percent'), 0);
  r           record;
  v_user_day  bigint;
  v_spread    bigint;
  v_goals     int    := 0;
  v_total     bigint := 0;
  v_spread_total bigint := 0;
BEGIN
  IF v_last >= v_today THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'already accrued today');
  END IF;
  UPDATE public.platform_settings SET value = v_today::text WHERE key = 'goal_interest_last_accrued_on';

  IF v_backing <= 0 THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'not backed');
  END IF;
  v_rate := LEAST(v_rate, v_backing);   -- never pay more than the backing earns

  FOR r IN
    SELECT id, user_id, saved_usdc_micro FROM public.savings_goals
    WHERE status = 'active' AND saved_usdc_micro > 0
    FOR UPDATE
  LOOP
    v_user_day := floor(r.saved_usdc_micro * (v_rate / 100.0) / 365.0);
    v_spread   := floor(r.saved_usdc_micro * ((v_backing - v_rate) / 100.0) / 365.0);
    IF v_user_day > 0 THEN
      UPDATE public.savings_goals SET interest_earned_micro = interest_earned_micro + v_user_day WHERE id = r.id;
      v_goals := v_goals + 1;
      v_total := v_total + v_user_day;
    END IF;
    IF v_spread > 0 THEN
      INSERT INTO public.revenue_journal (user_id, revenue_type, amount_usdc_micro, description)
      VALUES (r.user_id, 'yield_spread', v_spread, format('Goal spread: backing %s%% - user %s%%', v_backing, v_rate));
      v_spread_total := v_spread_total + v_spread;
    END IF;
  END LOOP;

  IF v_spread_total > 0 THEN
    UPDATE public.platform_settings
    SET value = (COALESCE(value::bigint, 0) + floor(v_spread_total / 10000))::text
    WHERE key = 'platform_revenue_kobo';
  END IF;

  RETURN jsonb_build_object('ok', true, 'goals', v_goals, 'interest_micro', v_total,
                            'spread_micro', v_spread_total, 'user_apy', v_rate, 'backing_apy', v_backing);
END;
$$;
REVOKE ALL ON FUNCTION public.accrue_goal_interest() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accrue_goal_interest() TO service_role;

-- ── 2b. Goal completion: 106's body + the accrued interest ────────────────────
CREATE OR REPLACE FUNCTION public.complete_savings_goal(p_goal_id UUID, p_user_id UUID)
RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_goal     public.savings_goals%ROWTYPE;
  v_interest bigint;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() != p_user_id THEN RAISE EXCEPTION 'unauthorized'; END IF;
  SELECT * INTO v_goal FROM public.savings_goals WHERE id = p_goal_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'goal not found'; END IF;
  IF v_goal.status != 'active' THEN RAISE EXCEPTION 'goal is not active'; END IF;
  IF v_goal.saved_usdc_micro < v_goal.target_usdc_micro THEN RAISE EXCEPTION 'target not yet reached'; END IF;

  -- Interest is whatever accrue_goal_interest() actually credited while the money was in
  -- gNTB. Zero for a goal that was never backed.
  v_interest := GREATEST(COALESCE(v_goal.interest_earned_micro, 0), 0);

  UPDATE public.wallets
  SET usdc_balance_micro = usdc_balance_micro + v_goal.saved_usdc_micro + v_interest, updated_at = now()
  WHERE user_id = p_user_id;

  UPDATE public.savings_goals
  SET status = 'completed', interest_earned_micro = v_interest, completed_at = NOW()
  WHERE id = p_goal_id;

  INSERT INTO public.transactions
    (user_id, type, direction, amount_kobo, amount_usdc_micro, description, status)
  VALUES
    (p_user_id, 'goal_claim', 'credit', v_goal.saved_naira_kobo + floor(v_interest / 10000), v_goal.saved_usdc_micro + v_interest,
     CASE WHEN v_interest > 0
          THEN format('Goal "%s" reached — principal + N%s interest', v_goal.title, round(v_interest / 1000000.0, 2))
          ELSE format('Goal "%s" reached — principal returned', v_goal.title) END,
     'completed');

  RETURN v_interest;
END;
$$;
GRANT EXECUTE ON FUNCTION public.complete_savings_goal(UUID, UUID) TO authenticated, service_role;

-- ── 3a. Circles: daily accrual on the pot's actual balance ────────────────────
-- Every circle with money in its pot (rotating Ajo, aso ebi, dues, harambee, group buy,
-- chama) earns the Ajo rate on it for the day. The interest stays with the pot; the spread
-- is ours the same day. Idempotent per UTC day.
CREATE OR REPLACE FUNCTION public.accrue_circle_interest()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_today   date    := (now() AT TIME ZONE 'utc')::date;
  v_last    date    := COALESCE((SELECT value::date FROM public.platform_settings WHERE key = 'circle_interest_last_accrued_on'), '1970-01-01');
  v_rate    numeric := COALESCE((SELECT value::numeric FROM public.platform_settings WHERE key = 'ajo_user_apy_percent'), 10.5);
  v_backing numeric := COALESCE((SELECT value::numeric FROM public.platform_settings WHERE key = 'yield_backing_apy_percent'), 0);
  r         record;
  v_pot     bigint;
  v_user_day bigint;
  v_spread  bigint;
  v_circles int    := 0;
  v_total   bigint := 0;
  v_spread_total bigint := 0;
BEGIN
  IF v_last >= v_today THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'already accrued today');
  END IF;
  UPDATE public.platform_settings SET value = v_today::text WHERE key = 'circle_interest_last_accrued_on';

  IF v_backing <= 0 THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'not backed');
  END IF;
  v_rate := LEAST(v_rate, v_backing);

  FOR r IN
    SELECT id, owner_id, pot_balance_kobo FROM public.esusu_groups
    WHERE status IN ('forming', 'active') AND pot_balance_kobo > 0
    FOR UPDATE
  LOOP
    v_pot      := r.pot_balance_kobo * 10000;
    v_user_day := floor(v_pot * (v_rate / 100.0) / 365.0);
    v_spread   := floor(v_pot * ((v_backing - v_rate) / 100.0) / 365.0);
    IF v_user_day > 0 THEN
      UPDATE public.esusu_groups SET interest_accrued_micro = interest_accrued_micro + v_user_day WHERE id = r.id;
      v_circles := v_circles + 1;
      v_total   := v_total + v_user_day;
    END IF;
    IF v_spread > 0 THEN
      INSERT INTO public.revenue_journal (user_id, revenue_type, amount_usdc_micro, description)
      VALUES (r.owner_id, 'yield_spread', v_spread, format('Circle spread (%s): backing %s%% - user %s%%', r.id, v_backing, v_rate));
      v_spread_total := v_spread_total + v_spread;
    END IF;
  END LOOP;

  IF v_spread_total > 0 THEN
    UPDATE public.platform_settings
    SET value = (COALESCE(value::bigint, 0) + floor(v_spread_total / 10000))::text
    WHERE key = 'platform_revenue_kobo';
  END IF;

  RETURN jsonb_build_object('ok', true, 'circles', v_circles, 'interest_micro', v_total,
                            'spread_micro', v_spread_total, 'user_apy', v_rate, 'backing_apy', v_backing);
END;
$$;
REVOKE ALL ON FUNCTION public.accrue_circle_interest() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accrue_circle_interest() TO service_role;

-- ── 3b. Ajo payout: 099's process_esusu_payout + the pot's accrued interest ───
CREATE OR REPLACE FUNCTION public.process_esusu_payout(p_group_id uuid)
RETURNS jsonb AS $$
DECLARE
  v_group public.esusu_groups%rowtype;
  v_member_count int; v_contrib_count int;
  v_recipient public.esusu_members%rowtype;
  v_payout_kobo bigint; v_creator_cut_kobo bigint; v_net_payout_kobo bigint; v_clawback_kobo bigint := 0;
  v_next_cycle int;
  v_yield_micro bigint := 0;
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

  -- The pot's interest (new in 115): whatever accrue_circle_interest() added while this
  -- cycle's money sat in the pot. It goes to the recipient with the pot. Our spread was
  -- already booked day by day, so there is nothing to split here.
  v_yield_micro := GREATEST(COALESCE(v_group.interest_accrued_micro, 0), 0);
  IF v_yield_micro > 0 THEN
    UPDATE public.wallets SET usdc_balance_micro = usdc_balance_micro + v_yield_micro, updated_at = now()
    WHERE user_id = v_recipient.user_id;
    INSERT INTO public.transactions (user_id, type, direction, amount_kobo, amount_usdc_micro, description)
    VALUES (v_recipient.user_id, 'esusu_payout', 'credit', floor(v_yield_micro / 10000), v_yield_micro,
            format('Ajo interest - Cycle %s of "%s"', v_group.current_cycle, v_group.name));
  END IF;

  IF v_creator_cut_kobo > 0 THEN
    UPDATE public.wallets SET usdc_balance_micro = usdc_balance_micro + (v_creator_cut_kobo * 10000), updated_at = now()
    WHERE user_id = v_group.owner_id;
    INSERT INTO public.transactions (user_id, type, direction, amount_kobo, amount_usdc_micro, description)
    VALUES (v_group.owner_id, 'creator_incentive', 'credit', v_creator_cut_kobo, (v_creator_cut_kobo * 10000),
            format('Creator incentive %s%% from "%s" Cycle %s', round(v_group.creator_incentive_percent, 1), v_group.name, v_group.current_cycle));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.esusu_members WHERE group_id = p_group_id AND NOT removed AND NOT has_collected) THEN
    UPDATE public.esusu_groups SET pot_balance_kobo = 0, interest_accrued_micro = 0, current_cycle = v_next_cycle, cycle_started_at = now(), status = 'completed' WHERE id = p_group_id;
  ELSE
    UPDATE public.esusu_groups SET pot_balance_kobo = 0, interest_accrued_micro = 0, current_cycle = v_next_cycle, cycle_started_at = now() WHERE id = p_group_id;
  END IF;

  RETURN jsonb_build_object('ok',true,'paid_to',v_recipient.user_id,'amount_kobo',v_net_payout_kobo,
    'creator_cut_kobo',v_creator_cut_kobo,'cycle',v_group.current_cycle,'next_cycle',v_next_cycle,
    'interest_micro',v_yield_micro,
    'completed',(NOT EXISTS (SELECT 1 FROM public.esusu_members WHERE group_id = p_group_id AND NOT removed AND NOT has_collected)));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
GRANT EXECUTE ON FUNCTION public.process_esusu_payout(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.process_esusu_payout(uuid) FROM PUBLIC, anon;

-- The old browser-driven Ajo yield path is retired (see header). Its claim function is
-- service-only already; make it inert so nothing can pay its old 33% again.
CREATE OR REPLACE FUNCTION public.esusu_claim_mm_position(p_group_id uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER AS $$
  SELECT jsonb_build_object('ok', false, 'reason', 'retired_see_115');
$$;
REVOKE ALL ON FUNCTION public.esusu_claim_mm_position(uuid) FROM PUBLIC, anon, authenticated;

-- ── 3c. Collection / chama settle: 085's circle_settle + the pot's interest ───
CREATE OR REPLACE FUNCTION public.circle_settle(
  p_group_id UUID,
  p_actor    UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  g        public.esusu_groups%rowtype;
  v_micro  BIGINT;
  v_kobo   BIGINT;
  v_int    BIGINT;
  v_ref    TEXT;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_actor THEN
    RAISE EXCEPTION 'circle_settle: unauthorized';
  END IF;

  SELECT * INTO g FROM public.esusu_groups WHERE id = p_group_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'circle_settle: circle not found'; END IF;
  IF g.payout_mode NOT IN ('collection','investment') THEN
    RAISE EXCEPTION 'circle_settle: only collection/investment circles settle this way';
  END IF;
  IF g.beneficiary_id IS NULL THEN RAISE EXCEPTION 'circle_settle: no beneficiary set'; END IF;
  IF p_actor <> g.owner_id AND p_actor <> g.beneficiary_id THEN
    RAISE EXCEPTION 'circle_settle: only the owner or beneficiary can settle';
  END IF;
  IF g.status = 'settled' THEN RETURN TRUE; END IF; -- idempotent
  IF g.status NOT IN ('forming','active') THEN
    RAISE EXCEPTION 'circle_settle: circle is % — cannot settle', g.status;
  END IF;

  v_kobo  := g.pot_balance_kobo;
  v_int   := GREATEST(COALESCE(g.interest_accrued_micro, 0), 0);
  v_micro := v_kobo * 10000 + v_int;

  UPDATE public.esusu_groups
    SET status = 'settled', pot_balance_kobo = 0, interest_accrued_micro = 0, settled_at = now()
    WHERE id = p_group_id;

  IF v_micro > 0 THEN
    UPDATE public.wallets
      SET usdc_balance_micro = usdc_balance_micro + v_micro, updated_at = now()
      WHERE user_id = g.beneficiary_id;

    v_ref := 'circle_settle_' || p_group_id::text;
    INSERT INTO public.transactions
      (user_id, type, direction, amount_kobo, amount_usdc_micro, description, reference, status, metadata)
    VALUES
      (g.beneficiary_id, 'esusu_payout', 'credit', v_kobo + floor(v_int / 10000), v_micro,
       CASE WHEN v_int > 0
            THEN format('Received from "%s" (includes N%s interest)', COALESCE(g.name,'Circle'), round(v_int / 1000000.0, 2))
            ELSE 'Received from "' || COALESCE(g.name,'Circle') || '"' END,
       v_ref, 'completed',
       jsonb_build_object('circle_id', p_group_id, 'circle_type', g.circle_type, 'interest_micro', v_int));
  END IF;

  RETURN TRUE;
END;
$$;
REVOKE ALL ON FUNCTION public.circle_settle(UUID,UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.circle_settle(UUID,UUID) TO service_role;

-- ── 4. Fixed savings: 099's hardened body + gate + 20% annual rate ────────────
-- Keeps 099's owner check, offered-term guard (exact rows in fixed_savings_rates) and
-- effective_rate_at_creation. Changes: refuses while fixed_savings_enabled <> 'true', and
-- prices every offered term at fixed_user_apy_percent a year, prorated, instead of the
-- 022 effective-rate tiers (up to 49.7% over a year). The signature also takes the
-- p_user_consent_accepted argument the app sends, which the 5-arg version rejected.
DROP FUNCTION IF EXISTS public.lock_savings(uuid, bigint, bigint, int, numeric);
CREATE OR REPLACE FUNCTION public.lock_savings(
  p_user_id               uuid,
  p_usdc_micro            bigint,
  p_kobo                  bigint,
  p_duration_days         int,
  p_apy                   numeric DEFAULT NULL,   -- accepted, ignored (099)
  p_user_consent_accepted boolean DEFAULT false
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  w          public.wallets%rowtype;
  v_enabled  text    := COALESCE((SELECT value FROM public.platform_settings WHERE key = 'fixed_savings_enabled'), 'false');
  v_annual   numeric := COALESCE((SELECT value::numeric FROM public.platform_settings WHERE key = 'fixed_user_apy_percent'), 20);
  v_rate     numeric;   -- effective rate over the whole term
  v_projected bigint;
  v_lock_id  uuid;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'lock_savings: unauthorized';
  END IF;
  IF v_enabled <> 'true' THEN
    RAISE EXCEPTION 'Fixed savings is coming soon';
  END IF;
  IF p_usdc_micro IS NULL OR p_usdc_micro <= 0 THEN
    RAISE EXCEPTION 'lock_savings: amount must be positive';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.fixed_savings_rates WHERE duration_days = p_duration_days) THEN
    RAISE EXCEPTION 'lock_savings: % days is not an offered term', p_duration_days;
  END IF;

  SELECT * INTO w FROM public.wallets WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'lock_savings: no wallet'; END IF;
  IF w.cngn_pool_micro < p_usdc_micro THEN
    RAISE EXCEPTION 'Insufficient cNGN balance';
  END IF;

  v_rate      := round(v_annual * p_duration_days / 365.0, 4);
  v_projected := floor(p_usdc_micro::numeric * v_rate / 100.0);

  UPDATE public.wallets
  SET cngn_pool_micro = cngn_pool_micro - p_usdc_micro, updated_at = now()
  WHERE user_id = p_user_id;

  INSERT INTO public.savings_locks (
    user_id, amount_usdc_micro, amount_kobo, apy_percent, duration_days,
    projected_interest_micro, effective_rate_at_creation, unlocks_at
  ) VALUES (
    p_user_id, p_usdc_micro, p_kobo, v_annual, p_duration_days,
    v_projected, v_rate, now() + (p_duration_days || ' days')::interval
  ) RETURNING id INTO v_lock_id;

  INSERT INTO public.transactions (user_id, type, direction, amount_kobo, amount_usdc_micro, description, status)
  VALUES (p_user_id, 'save_to_vault', 'debit', p_kobo, p_usdc_micro,
          'Locked cNGN savings for ' || p_duration_days || ' days at ' || v_annual || '% a year', 'completed');

  RETURN v_lock_id;
END;
$$;
REVOKE ALL ON FUNCTION public.lock_savings(uuid, bigint, bigint, int, numeric, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lock_savings(uuid, bigint, bigint, int, numeric, boolean) TO authenticated, service_role;

-- ── 5. Expose the new rates to the app (read-only, non-sensitive) ─────────────
-- The app shows Goals/Ajo rates only when yield_backing_apy_percent > 0, and opens fixed
-- deposits only when fixed_savings_enabled = 'true', so both read from here.
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
    'cngn_pool_apy_percent',
    'ajo_user_apy_percent',
    'goals_user_apy_percent',
    'fixed_user_apy_percent',
    'fixed_savings_enabled',
    'yield_backing_apy_percent'
  );
  RETURN COALESCE(result, '{}'::jsonb);
END;
$$ LANGUAGE plpgsql STABLE;
GRANT EXECUTE ON FUNCTION public.get_apy_settings() TO anon, authenticated, service_role;
