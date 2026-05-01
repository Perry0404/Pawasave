-- ============================================================
-- Migration 007: Daily yield accrual on cNGN yield pool
-- Run this ENTIRE script in Supabase SQL Editor
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- PART A: Daily yield accrual function
-- Called once per day by the Vercel cron job at /api/cron/accrue-yield
-- Computes daily_rate = APY / 365, credits each user's
-- cngn_yield_earned_micro, and inserts an audit transaction row.
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.accrue_daily_yield()
RETURNS jsonb AS $$
DECLARE
  v_apy_percent  numeric;
  v_daily_rate   numeric;
  v_rec          record;
  v_yield_micro  bigint;
  v_users_count  integer := 0;
  v_total_yield  bigint  := 0;
BEGIN
  -- Read the configured APY from platform_settings
  SELECT value::numeric INTO v_apy_percent
  FROM public.platform_settings
  WHERE key = 'cngn_pool_apy_percent';

  v_apy_percent := COALESCE(v_apy_percent, 21.0);
  v_daily_rate  := v_apy_percent / 100.0 / 365.0;

  FOR v_rec IN
    SELECT user_id, cngn_pool_micro + cngn_yield_earned_micro AS pool_balance
    FROM public.wallets
    WHERE cngn_pool_micro > 0
  LOOP
    -- Yield accrues on principal + compounding earned yield
    v_yield_micro := floor(v_rec.pool_balance * v_daily_rate);

    IF v_yield_micro > 0 THEN
      UPDATE public.wallets
      SET cngn_yield_earned_micro = cngn_yield_earned_micro + v_yield_micro,
          updated_at = now()
      WHERE user_id = v_rec.user_id;

      -- Audit row so users can see yield in their transaction history
      INSERT INTO public.transactions (
        user_id, type, direction, amount_kobo, amount_usdc_micro,
        description, status
      ) VALUES (
        v_rec.user_id, 'cngn_pool_in', 'credit', 0, v_yield_micro,
        format('Daily yield – %.2f%% APY (Xend Money Market)', v_apy_percent),
        'completed'
      );

      v_users_count := v_users_count + 1;
      v_total_yield := v_total_yield + v_yield_micro;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'users_credited', v_users_count,
    'total_yield_micro', v_total_yield,
    'apy_percent', v_apy_percent
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.accrue_daily_yield() TO service_role;

-- ────────────────────────────────────────────────────────────
-- PART B: Compound yield into principal (manual/admin action)
-- Adds earned yield into the pool principal and resets the
-- earned counter.  Call this periodically (e.g. monthly).
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.compound_yield(p_user_id uuid)
RETURNS void AS $$
BEGIN
  UPDATE public.wallets
  SET cngn_pool_micro       = cngn_pool_micro + cngn_yield_earned_micro,
      cngn_yield_earned_micro = 0,
      updated_at = now()
  WHERE user_id = p_user_id
    AND cngn_yield_earned_micro > 0;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.compound_yield(uuid) TO service_role;

-- ────────────────────────────────────────────────────────────
-- PART C: Yield summary view (optional, for admin dashboards)
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW public.yield_summary AS
SELECT
  p.id            AS user_id,
  p.display_name,
  p.phone,
  w.cngn_pool_micro,
  w.cngn_yield_earned_micro,
  w.cngn_pool_micro + w.cngn_yield_earned_micro AS total_pool_value_micro,
  w.updated_at
FROM public.wallets w
JOIN public.profiles p ON p.id = w.user_id
WHERE w.cngn_pool_micro > 0 OR w.cngn_yield_earned_micro > 0;
