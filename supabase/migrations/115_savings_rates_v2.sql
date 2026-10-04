-- 099_savings_rates_v2.sql
-- New savings rates backed by real yield, rates moved server-side, fixed savings gated.
--
-- WHY:
--   * Goals paid a hard-coded 33% APY (071) and Ajo 27-33% (011 + /api/esusu/yield),
--     credited from platform reserves. The only live backing asset, GetEquity's gNTB
--     T-bill fund, yields ~14.5%, so every naira saved lost money.
--   * lock_savings (008, still live) TRUSTED a caller-supplied p_apy and had NO auth.uid()
--     check. Any signed-in user could lock their own cNGN at an arbitrary APY and
--     withdraw_lock (042) would pay that projected interest at maturity: a direct
--     unbacked mint. It also let a caller target another user's wallet.
--
-- NEW RATES (founder, 2026-10-04): Ajo 10.5%, Goals 12%, Fixed 20% (gated until the
-- GetEquity CP/credit fund is live). The spread to the backing yield is platform revenue.
--
-- REVENUE: the spread is booked only when `yield_backing_apy_percent` > 0. It stays 0
-- until custody actually deploys savings into gNTB (getequity-yield cron), so no phantom
-- revenue is recorded before the money is really earning. Set it to the gNTB rate
-- (e.g. 14.5) when the yield engine is live.

-- ── 1. Settings ───────────────────────────────────────────────────────────────
INSERT INTO public.platform_settings (key, value) VALUES
  ('ajo_user_apy_percent',   '10.5'),
  ('goals_user_apy_percent', '12'),
  ('fixed_user_apy_percent', '20'),
  ('fixed_savings_enabled',  'false')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

INSERT INTO public.platform_settings (key, value) VALUES
  ('yield_backing_apy_percent', '0')
ON CONFLICT (key) DO NOTHING;

-- ── 2. Goal completion: 12% (setting), spread booked as revenue when backed ────
CREATE OR REPLACE FUNCTION public.complete_savings_goal(p_goal_id UUID, p_user_id UUID)
RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_goal     public.savings_goals%ROWTYPE;
  v_days     NUMERIC;
  v_rate     NUMERIC := COALESCE((SELECT value::numeric FROM public.platform_settings WHERE key = 'goals_user_apy_percent'), 12);
  v_backing  NUMERIC := COALESCE((SELECT value::numeric FROM public.platform_settings WHERE key = 'yield_backing_apy_percent'), 0);
  v_interest BIGINT;
  v_spread   BIGINT := 0;
  v_total    BIGINT;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() != p_user_id THEN RAISE EXCEPTION 'unauthorized'; END IF;
  SELECT * INTO v_goal FROM public.savings_goals WHERE id = p_goal_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'goal not found'; END IF;
  IF v_goal.status != 'active' THEN RAISE EXCEPTION 'goal is not active'; END IF;
  IF v_goal.saved_usdc_micro < v_goal.target_usdc_micro THEN RAISE EXCEPTION 'target not yet reached'; END IF;

  v_days     := GREATEST(1, EXTRACT(EPOCH FROM (NOW() - v_goal.started_at)) / 86400.0);
  v_interest := FLOOR(v_goal.saved_usdc_micro * (v_rate / 100.0) * (v_days / 365.0));
  v_total    := v_goal.saved_usdc_micro + v_interest;

  UPDATE public.wallets
  SET usdc_balance_micro = usdc_balance_micro + v_total, updated_at = now()
  WHERE user_id = p_user_id;

  UPDATE public.savings_goals
  SET status = 'completed', interest_earned_micro = v_interest, completed_at = NOW()
  WHERE id = p_goal_id;

  IF v_backing > v_rate THEN
    v_spread := FLOOR(v_goal.saved_usdc_micro * ((v_backing - v_rate) / 100.0) * (v_days / 365.0));
    IF v_spread > 0 THEN
      INSERT INTO public.revenue_journal (user_id, revenue_type, amount_usdc_micro, description)
      VALUES (p_user_id, 'yield_spread', v_spread,
              format('Goal spread: backing %s%% - user %s%%', v_backing, v_rate));
      UPDATE public.platform_settings
      SET value = (COALESCE(value::bigint, 0) + FLOOR(v_spread / 10000))::text
      WHERE key = 'platform_revenue_kobo';
    END IF;
  END IF;

  RETURN v_interest;
END;
$$;
GRANT EXECUTE ON FUNCTION public.complete_savings_goal(UUID, UUID) TO authenticated, service_role;

-- ── 3. Ajo pot yield: 10.5% (setting) + spread to revenue when backed ─────────
-- Adds an optional recipient so the spread can be attributed. Dropped first because
-- adding a parameter would otherwise create a second overload.
DROP FUNCTION IF EXISTS public.esusu_claim_mm_position(uuid);
CREATE OR REPLACE FUNCTION public.esusu_claim_mm_position(
  p_group_id          uuid,
  p_recipient_user_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_usdc_micro  bigint;
  v_start_at    timestamptz;
  v_days        numeric;
  v_rate        numeric := COALESCE((SELECT value::numeric FROM public.platform_settings WHERE key = 'ajo_user_apy_percent'), 10.5);
  v_backing     numeric := COALESCE((SELECT value::numeric FROM public.platform_settings WHERE key = 'yield_backing_apy_percent'), 0);
  v_yield_micro bigint;
  v_spread      bigint := 0;
BEGIN
  SELECT xend_mm_usdc_micro, xend_mm_cycle_start_at
  INTO v_usdc_micro, v_start_at
  FROM public.esusu_groups WHERE id = p_group_id FOR UPDATE;

  IF v_usdc_micro IS NULL OR v_usdc_micro = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_position');
  END IF;

  v_days        := EXTRACT(EPOCH FROM (now() - COALESCE(v_start_at, now()))) / 86400.0;
  v_yield_micro := floor(v_usdc_micro * (v_rate / 100.0) / 365.0 * GREATEST(v_days, 0));

  UPDATE public.esusu_groups
  SET xend_mm_usdc_micro = 0, xend_mm_cycle_start_at = NULL
  WHERE id = p_group_id;

  IF v_backing > v_rate THEN
    v_spread := floor(v_usdc_micro * ((v_backing - v_rate) / 100.0) / 365.0 * GREATEST(v_days, 0));
    IF v_spread > 0 THEN
      INSERT INTO public.revenue_journal (user_id, revenue_type, amount_usdc_micro, description)
      VALUES (p_recipient_user_id, 'yield_spread', v_spread,
              format('Ajo spread (group %s): backing %s%% - user %s%%', p_group_id, v_backing, v_rate));
      UPDATE public.platform_settings
      SET value = (COALESCE(value::bigint, 0) + floor(v_spread / 10000))::text
      WHERE key = 'platform_revenue_kobo';
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok',                   true,
    'deposited_usdc_micro', v_usdc_micro,
    'yield_usdc_micro',     v_yield_micro,
    'total_usdc_micro',     v_usdc_micro + v_yield_micro,
    'apy_percent',          v_rate,
    'days',                 round(v_days::numeric, 2)
  );
END;
$$;
REVOKE ALL ON FUNCTION public.esusu_claim_mm_position(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.esusu_claim_mm_position(uuid, uuid) TO service_role;

-- ── 4. Fixed savings: gated, server-side rate, owner-only ─────────────────────
-- Replaces the live 5-arg version. The new signature also accepts the
-- p_user_consent_accepted argument the app already sends (its absence was making every
-- lock call fail). p_apy is still accepted for compatibility but IGNORED.
DROP FUNCTION IF EXISTS public.lock_savings(uuid, bigint, bigint, int, numeric);
CREATE OR REPLACE FUNCTION public.lock_savings(
  p_user_id               uuid,
  p_usdc_micro            bigint,
  p_kobo                  bigint,
  p_duration_days         int,
  p_apy                   numeric DEFAULT NULL,
  p_user_consent_accepted boolean DEFAULT false
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  w           public.wallets%rowtype;
  v_enabled   text    := COALESCE((SELECT value FROM public.platform_settings WHERE key = 'fixed_savings_enabled'), 'false');
  v_rate      numeric := COALESCE((SELECT value::numeric FROM public.platform_settings WHERE key = 'fixed_user_apy_percent'), 20);
  v_projected bigint;
  v_lock_id   uuid;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() != p_user_id THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  IF v_enabled <> 'true' THEN
    RAISE EXCEPTION 'Fixed savings is coming soon';
  END IF;
  IF p_usdc_micro IS NULL OR p_usdc_micro <= 0 THEN
    RAISE EXCEPTION 'Amount must be positive';
  END IF;
  IF p_duration_days IS NULL OR p_duration_days < 30 OR p_duration_days > 730 THEN
    RAISE EXCEPTION 'Invalid lock duration';
  END IF;

  SELECT * INTO w FROM public.wallets WHERE user_id = p_user_id FOR UPDATE;
  IF w.cngn_pool_micro < p_usdc_micro THEN
    RAISE EXCEPTION 'Insufficient cNGN balance';
  END IF;

  v_projected := floor(p_usdc_micro::numeric * (v_rate / 100.0) * (p_duration_days::numeric / 365.0));

  UPDATE public.wallets
  SET cngn_pool_micro = cngn_pool_micro - p_usdc_micro, updated_at = now()
  WHERE user_id = p_user_id;

  INSERT INTO public.savings_locks (
    user_id, amount_usdc_micro, amount_kobo, apy_percent, duration_days,
    projected_interest_micro, unlocks_at
  ) VALUES (
    p_user_id, p_usdc_micro, p_kobo, v_rate, p_duration_days,
    v_projected, now() + (p_duration_days || ' days')::interval
  ) RETURNING id INTO v_lock_id;

  INSERT INTO public.transactions (user_id, type, direction, amount_kobo, amount_usdc_micro, description, status)
  VALUES (p_user_id, 'save_to_vault', 'debit', p_kobo, p_usdc_micro,
          'Locked cNGN savings for ' || p_duration_days || ' days at ' || v_rate || '% APY', 'completed');

  RETURN v_lock_id;
END;
$$;
REVOKE ALL ON FUNCTION public.lock_savings(uuid, bigint, bigint, int, numeric, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lock_savings(uuid, bigint, bigint, int, numeric, boolean) TO authenticated, service_role;
