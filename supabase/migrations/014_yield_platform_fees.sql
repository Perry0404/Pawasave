-- ============================================================
-- Migration 014: Platform fee capture for yield products
--
-- Two fee streams:
-- A. XEND X Auto (56% APY) → users get 50%, platform keeps 6% spread
--    Captured at lock maturity inside withdraw_lock.
--
-- B. XEND Money Market → users always get 33% APY.
--    If the actual MM rate ever exceeds 33%, the excess accrues
--    to platform revenue automatically inside accrue_daily_yield.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- PART A: withdraw_lock — capture 6% X Auto platform spread at maturity
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.withdraw_lock(
  p_user_id uuid,
  p_lock_id uuid,
  p_early boolean DEFAULT false
) RETURNS boolean AS $$
DECLARE
  v_lock         public.savings_locks%rowtype;
  v_payout       bigint;
  v_penalty_kobo bigint := 0;
  v_spread_micro bigint := 0;
  v_xauto_rate   numeric := 56.0;
  v_user_rate    numeric := 50.0;
BEGIN
  SELECT * INTO v_lock FROM public.savings_locks
  WHERE id = p_lock_id AND user_id = p_user_id AND status = 'active'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF p_early AND now() < v_lock.unlocks_at THEN
    -- Early withdrawal: principal only, 0.5% penalty
    v_payout := v_lock.amount_usdc_micro;
    v_penalty_kobo := floor(v_lock.amount_kobo * 0.005);

    UPDATE public.savings_locks
    SET status = 'early_withdrawn', withdrawn_at = now()
    WHERE id = p_lock_id;

    IF v_penalty_kobo > 0 THEN
      INSERT INTO public.platform_fees (
        user_id, transaction_ref, fee_type, gross_amount_kobo, fee_amount_kobo, fee_percent
      ) VALUES (
        p_user_id, p_lock_id::text, 'vault_lock_penalty', v_lock.amount_kobo, v_penalty_kobo, 0.50
      );

      UPDATE public.platform_settings
      SET value = (COALESCE(value::bigint, 0) + v_penalty_kobo)::text
      WHERE key = 'platform_revenue_kobo';
    END IF;

  ELSE
    -- Matured withdrawal: pay user principal + projected interest (50% APY)
    v_payout := v_lock.amount_usdc_micro + v_lock.projected_interest_micro;

    -- Platform spread: difference between X Auto (56%) and user rate (50%)
    -- platform_spread = principal * (xauto_rate - user_rate) / 100 * (duration / 365)
    SELECT COALESCE(value::numeric, 56.0) INTO v_xauto_rate
    FROM public.platform_settings WHERE key = 'xauto_product_apy_percent';

    SELECT COALESCE(value::numeric, 50.0) INTO v_user_rate
    FROM public.platform_settings WHERE key = 'xauto_user_apy_percent';

    v_spread_micro := FLOOR(
      v_lock.amount_usdc_micro::numeric
      * ((v_xauto_rate - v_user_rate) / 100.0)
      * (v_lock.duration_days::numeric / 365.0)
    );

    UPDATE public.savings_locks
    SET status = 'withdrawn', matured_at = now(), withdrawn_at = now()
    WHERE id = p_lock_id;

    -- Log platform spread as a fee record (for accounting)
    IF v_spread_micro > 0 THEN
      INSERT INTO public.platform_fees (
        user_id, transaction_ref, fee_type, gross_amount_kobo, fee_amount_kobo, fee_percent
      ) VALUES (
        p_user_id, p_lock_id::text, 'xauto_spread',
        v_lock.amount_kobo,
        floor(v_lock.amount_kobo::numeric * ((v_xauto_rate - v_user_rate) / 100.0) * (v_lock.duration_days::numeric / 365.0)),
        (v_xauto_rate - v_user_rate)
      );
    END IF;
  END IF;

  UPDATE public.wallets
  SET cngn_pool_micro = cngn_pool_micro + v_payout,
      updated_at = now()
  WHERE user_id = p_user_id;

  INSERT INTO public.transactions (
    user_id, type, direction, amount_kobo, amount_usdc_micro,
    description, status
  ) VALUES (
    p_user_id, 'vault_withdraw', 'credit',
    v_lock.amount_kobo,
    v_payout,
    CASE WHEN p_early
      THEN 'Early lock withdrawal (principal only)'
      ELSE 'Matured lock withdrawn + ' || v_lock.projected_interest_micro || ' uUSDC interest (X Auto 50% APY)'
    END,
    'completed'
  );

  RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.withdraw_lock(uuid, uuid, boolean) TO service_role;

-- ────────────────────────────────────────────────────────────
-- PART B: accrue_daily_yield — cap users at 33%, excess → platform revenue
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.accrue_daily_yield()
RETURNS jsonb AS $$
DECLARE
  v_market_apy   numeric;   -- actual XEND Money Market rate (set by admin / cron)
  v_user_apy     numeric;   -- capped at 33% for users
  v_user_rate    numeric;   -- daily user rate
  v_excess_rate  numeric;   -- daily excess rate (goes to platform)
  v_rec          record;
  v_yield_micro  bigint;
  v_excess_micro bigint;
  v_users_count  integer := 0;
  v_total_yield  bigint  := 0;
  v_total_excess bigint  := 0;
BEGIN
  -- Actual Money Market APY from XEND (admin/cron keeps this updated)
  SELECT value::numeric INTO v_market_apy
  FROM public.platform_settings
  WHERE key = 'mm_market_apy_percent';

  v_market_apy := COALESCE(v_market_apy, 33.0);

  -- Users always get minimum(actual, 33%)
  v_user_apy    := LEAST(v_market_apy, 33.0);
  v_user_rate   := v_user_apy  / 100.0 / 365.0;
  v_excess_rate := GREATEST(v_market_apy - 33.0, 0) / 100.0 / 365.0;

  FOR v_rec IN
    SELECT user_id, cngn_pool_micro + cngn_yield_earned_micro AS pool_balance
    FROM public.wallets
    WHERE cngn_pool_micro > 0
  LOOP
    v_yield_micro  := floor(v_rec.pool_balance * v_user_rate);
    v_excess_micro := floor(v_rec.pool_balance * v_excess_rate);

    IF v_yield_micro > 0 THEN
      UPDATE public.wallets
      SET cngn_yield_earned_micro = cngn_yield_earned_micro + v_yield_micro,
          updated_at = now()
      WHERE user_id = v_rec.user_id;

      INSERT INTO public.transactions (
        user_id, type, direction, amount_kobo, amount_usdc_micro,
        description, status
      ) VALUES (
        v_rec.user_id, 'cngn_pool_in', 'credit', 0, v_yield_micro,
        format('Daily yield – %.2f%% APY (Money Market, capped at 33%%)', v_user_apy),
        'completed'
      );

      v_users_count := v_users_count + 1;
      v_total_yield := v_total_yield + v_yield_micro;
    END IF;

    -- If market rate > 33%, log excess as platform revenue
    IF v_excess_micro > 0 THEN
      INSERT INTO public.platform_fees (
        user_id, fee_type, amount_usdc_micro, description
      ) VALUES (
        v_rec.user_id, 'mm_excess_yield',  v_excess_micro,
        format('Money Market excess yield: market %.2f%% - user 33%% = %.2f%% spread', v_market_apy, v_market_apy - 33.0)
      );

      v_total_excess := v_total_excess + v_excess_micro;
    END IF;
  END LOOP;

  -- Aggregate excess into platform revenue counter
  IF v_total_excess > 0 THEN
    UPDATE public.platform_settings
    SET value = (COALESCE(value::bigint, 0) + v_total_excess)::text
    WHERE key = 'platform_revenue_kobo';
  END IF;

  RETURN jsonb_build_object(
    'users_credited', v_users_count,
    'total_yield_micro', v_total_yield,
    'user_apy_percent', v_user_apy,
    'market_apy_percent', v_market_apy,
    'excess_captured_micro', v_total_excess
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.accrue_daily_yield() TO service_role;

-- ────────────────────────────────────────────────────────────
-- PART C: Seed / update platform_settings with correct rate keys
-- ────────────────────────────────────────────────────────────
INSERT INTO public.platform_settings (key, value) VALUES
  ('mm_market_apy_percent',       '33'),    -- current XEND Money Market APY (update when XEND changes)
  ('mm_user_apy_percent',         '33'),    -- users always get min(market, 33)
  ('xauto_product_apy_percent',   '56'),    -- XEND X Auto product APY
  ('xauto_user_apy_percent',      '50'),    -- users earn 50% from X Auto
  ('xauto_platform_spread_percent', '6')    -- platform keeps 6% spread from X Auto
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
