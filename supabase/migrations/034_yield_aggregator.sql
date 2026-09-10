-- 034_yield_aggregator.sql
-- Multi-source yield aggregator wiring.
--
-- The credited savings APY must track what the treasury ACTUALLY earns, blended
-- across sources, split between users and platform. The cron
-- (/api/cron/update-yield-apy) computes the realised blended APY + the user share
-- and writes them here; accrue_daily_yield then credits users their share and
-- books the spread as platform revenue.

-- ── Policy + state settings ──────────────────────────────────────────────────
INSERT INTO public.platform_settings (key, value) VALUES
  ('yield_allocations',          '{"pawasave_lend":100}'), -- key→% of funds actually deployed per source
  ('yield_user_share_percent',   '70'),   -- % of realised yield passed to users
  ('yield_user_cap_percent',     '33'),   -- hard cap on the user APY (kept at 33 for continuity)
  ('yield_bootstrap_apy_percent','0'),    -- optional subsidised floor APY (conscious spend)
  ('yield_snapshot',             '{}')    -- last aggregator snapshot (for admin/visibility)
ON CONFLICT (key) DO NOTHING;

-- ── Generalise accrue_daily_yield: cap is now configurable (was hardcoded 33) ──
CREATE OR REPLACE FUNCTION public.accrue_daily_yield()
RETURNS jsonb AS $$
DECLARE
  v_market_apy   numeric;   -- realised blended market APY (set by the yield cron)
  v_user_cap     numeric;   -- max APY users receive
  v_user_apy     numeric;   -- min(market, cap)
  v_user_rate    numeric;   -- daily user rate
  v_excess_rate  numeric;   -- daily excess rate (platform revenue)
  v_rec          record;
  v_yield_micro  bigint;
  v_excess_micro bigint;
  v_users_count  integer := 0;
  v_total_yield  bigint  := 0;
  v_total_excess bigint  := 0;
BEGIN
  SELECT value::numeric INTO v_market_apy
  FROM public.platform_settings WHERE key = 'mm_market_apy_percent';
  v_market_apy := COALESCE(v_market_apy, 0.0);

  SELECT value::numeric INTO v_user_cap
  FROM public.platform_settings WHERE key = 'yield_user_cap_percent';
  v_user_cap := COALESCE(v_user_cap, 33.0);

  v_user_apy    := LEAST(v_market_apy, v_user_cap);
  v_user_rate   := v_user_apy / 100.0 / 365.0;
  v_excess_rate := GREATEST(v_market_apy - v_user_cap, 0) / 100.0 / 365.0;

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
        user_id, type, direction, amount_kobo, amount_usdc_micro, description, status
      ) VALUES (
        v_rec.user_id, 'cngn_pool_in', 'credit', 0, v_yield_micro,
        format('Daily yield – %.2f%% APY', v_user_apy), 'completed'
      );

      v_users_count := v_users_count + 1;
      v_total_yield := v_total_yield + v_yield_micro;
    END IF;

    IF v_excess_micro > 0 THEN
      INSERT INTO public.platform_fees (
        user_id, fee_type, amount_usdc_micro, description
      ) VALUES (
        v_rec.user_id, 'yield_spread', v_excess_micro,
        format('Yield spread: market %.2f%% - user %.2f%% = %.2f%%', v_market_apy, v_user_apy, v_market_apy - v_user_apy)
      );
      v_total_excess := v_total_excess + v_excess_micro;
    END IF;
  END LOOP;

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

-- ── Cron writes the computed state here ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_yield_state(
  p_market_apy numeric,   -- realised blended APY
  p_user_apy   numeric,   -- APY credited to users
  p_snapshot   jsonb      -- per-source detail for admin visibility
) RETURNS void AS $$
BEGIN
  INSERT INTO public.platform_settings (key, value) VALUES ('mm_market_apy_percent', p_market_apy::text) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
  INSERT INTO public.platform_settings (key, value) VALUES ('flexible_apy_percent', p_user_apy::text)   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
  INSERT INTO public.platform_settings (key, value) VALUES ('yield_user_cap_percent', p_user_apy::text) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
  INSERT INTO public.platform_settings (key, value) VALUES ('yield_snapshot', COALESCE(p_snapshot, '{}'::jsonb)::text) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.set_yield_state(numeric, numeric, jsonb) TO service_role;