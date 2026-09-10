-- 037_fix_yield_accrual.sql
-- Fix accrue_daily_yield so it doesn't crash the first day REAL yield flows.
--
-- Two latent bugs (masked today only because realised yield is 0, so the excess
-- branch never runs):
--   1) It INSERTs the platform spread into public.platform_fees using columns
--      (amount_usdc_micro, description) that DON'T EXIST on that table, with a
--      fee_type ('yield_spread') the CHECK constraint rejects — the insert throws
--      and aborts the whole daily accrual. The correct home for yield spread is
--      public.revenue_journal (created in 023), which HAS those columns and allows
--      revenue_type 'yield_spread'.
--   2) It adds v_total_excess (micro-cNGN, 1e6 = ₦1) straight into
--      platform_revenue_kobo (kobo, 1e2 = ₦1) — a 10,000x unit error. Convert
--      micro → kobo before adding.

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
      -- Book the spread in revenue_journal (correct schema + allowed revenue_type).
      INSERT INTO public.revenue_journal (
        user_id, revenue_type, amount_usdc_micro, description
      ) VALUES (
        v_rec.user_id, 'yield_spread', v_excess_micro,
        format('Yield spread: market %.2f%% - user %.2f%% = %.2f%%',
               v_market_apy, v_user_apy, v_market_apy - v_user_apy)
      );
      v_total_excess := v_total_excess + v_excess_micro;
    END IF;
  END LOOP;

  -- Add the spread to the withdrawable counter, converting micro-cNGN → kobo
  -- (₦1 = 1e6 micro = 100 kobo, so kobo = micro / 10000).
  IF v_total_excess > 0 THEN
    UPDATE public.platform_settings
    SET value = (COALESCE(value::bigint, 0) + floor(v_total_excess / 10000))::text
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