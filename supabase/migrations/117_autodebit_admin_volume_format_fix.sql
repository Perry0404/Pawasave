-- 117_autodebit_admin_volume_format_fix.sql  (run after 116)
--
-- 1. accrue_daily_yield: the last live function still using printf-style '%.2f' in format().
--    Postgres format() only knows %s %I %L, so the first day it credits anyone it throws
--    "unrecognized format() type specifier" and the nightly accrue-yield run fails. Same body
--    as 037, numbers rounded and passed as %s. (Every other '%.Nf' in older migrations sits in
--    a function that a later migration has since replaced.)
-- 2. Ajo auto-debit: members can have their contribution taken automatically, on time, when
--    the cycle falls due. esusu_auto_contribute() (hourly) pays it through esusu_contribute,
--    exactly as if the member tapped Contribute, then runs the payout. Default ON: the only
--    alternative today is the overdue sweep in esusu_autodebit, which takes the same money
--    later and adds a missed-payment strike, so on-time auto-debit is never worse for the
--    member. Goals already auto-save (015, auto_contribute_enabled); co-ops auto-pay (116).
-- 3. Admin volume counts Goals, Ajo/circles and cooperative dues.
-- 4. Admin revenue includes the daily yield spread from revenue_journal (115/116), which was
--    booked into platform_revenue_kobo but missing from the dashboard's totals.

-- ── 1. accrue_daily_yield without the invalid format specifiers ───────────────
CREATE OR REPLACE FUNCTION public.accrue_daily_yield()
RETURNS jsonb AS $$
DECLARE
  v_market_apy   numeric;
  v_user_cap     numeric;
  v_user_apy     numeric;
  v_user_rate    numeric;
  v_excess_rate  numeric;
  v_rec          record;
  v_yield_micro  bigint;
  v_excess_micro bigint;
  v_users_count  integer := 0;
  v_total_yield  bigint  := 0;
  v_total_excess bigint  := 0;
BEGIN
  SELECT value::numeric INTO v_market_apy FROM public.platform_settings WHERE key = 'mm_market_apy_percent';
  v_market_apy := COALESCE(v_market_apy, 0.0);
  SELECT value::numeric INTO v_user_cap FROM public.platform_settings WHERE key = 'yield_user_cap_percent';
  v_user_cap := COALESCE(v_user_cap, 33.0);

  v_user_apy    := LEAST(v_market_apy, v_user_cap);
  v_user_rate   := v_user_apy / 100.0 / 365.0;
  v_excess_rate := GREATEST(v_market_apy - v_user_cap, 0) / 100.0 / 365.0;

  FOR v_rec IN
    SELECT user_id, cngn_pool_micro + cngn_yield_earned_micro AS pool_balance
    FROM public.wallets WHERE cngn_pool_micro > 0
  LOOP
    v_yield_micro  := floor(v_rec.pool_balance * v_user_rate);
    v_excess_micro := floor(v_rec.pool_balance * v_excess_rate);

    IF v_yield_micro > 0 THEN
      UPDATE public.wallets
      SET cngn_yield_earned_micro = cngn_yield_earned_micro + v_yield_micro, updated_at = now()
      WHERE user_id = v_rec.user_id;
      INSERT INTO public.transactions (user_id, type, direction, amount_kobo, amount_usdc_micro, description, status)
      VALUES (v_rec.user_id, 'cngn_pool_in', 'credit', 0, v_yield_micro,
              format('Daily yield – %s%% APY', round(v_user_apy, 2)), 'completed');
      v_users_count := v_users_count + 1;
      v_total_yield := v_total_yield + v_yield_micro;
    END IF;

    IF v_excess_micro > 0 THEN
      INSERT INTO public.revenue_journal (user_id, revenue_type, amount_usdc_micro, description)
      VALUES (v_rec.user_id, 'yield_spread', v_excess_micro,
              format('Yield spread: market %s%% - user %s%% = %s%%',
                     round(v_market_apy, 2), round(v_user_apy, 2), round(v_market_apy - v_user_apy, 2)));
      v_total_excess := v_total_excess + v_excess_micro;
    END IF;
  END LOOP;

  IF v_total_excess > 0 THEN
    UPDATE public.platform_settings
    SET value = (COALESCE(value::bigint, 0) + floor(v_total_excess / 10000))::text
    WHERE key = 'platform_revenue_kobo';
  END IF;

  RETURN jsonb_build_object('users_credited', v_users_count, 'total_yield_micro', v_total_yield,
    'user_apy_percent', v_user_apy, 'market_apy_percent', v_market_apy, 'excess_captured_micro', v_total_excess);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
REVOKE ALL ON FUNCTION public.accrue_daily_yield() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accrue_daily_yield() TO service_role;

-- ── 2. Ajo auto-debit ─────────────────────────────────────────────────────────
ALTER TABLE public.esusu_members ADD COLUMN IF NOT EXISTS auto_debit BOOLEAN NOT NULL DEFAULT TRUE;

-- The member switches it for their own membership. (esusu_members has no client UPDATE policy.)
CREATE OR REPLACE FUNCTION public.esusu_set_auto_debit(p_group_id uuid, p_on boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'esusu_set_auto_debit: sign in'; END IF;
  UPDATE public.esusu_members SET auto_debit = p_on
  WHERE group_id = p_group_id AND user_id = auth.uid() AND NOT removed;
  IF NOT FOUND THEN RAISE EXCEPTION 'esusu_set_auto_debit: not a member of this circle'; END IF;
  RETURN p_on;
END;
$$;
REVOKE ALL ON FUNCTION public.esusu_set_auto_debit(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.esusu_set_auto_debit(uuid, boolean) TO authenticated;

-- Hourly. A rotating circle's cycle falls due one period after it started (the same clock
-- esusu_autodebit uses for the overdue sweep). From an hour before that, every auto-debit
-- member who hasn't paid this cycle is paid for, if their balance (spendable + savings pool)
-- covers it. Paced by the due date, so a circle where everyone auto-debits still pays out
-- once a period, not once an hour.
CREATE OR REPLACE FUNCTION public.esusu_auto_contribute()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  g        record;
  m        record;
  v_ok     boolean;
  v_paid   int := 0;
  v_short  int := 0;
  v_payouts int := 0;
  v_res    jsonb;
BEGIN
  FOR g IN
    SELECT id, current_cycle, contribution_amount_kobo FROM public.esusu_groups
    WHERE status = 'active' AND COALESCE(payout_mode, 'rotating') = 'rotating' AND contribution_amount_kobo > 0
      AND COALESCE(cycle_started_at, created_at) + (CASE cycle_period
            WHEN 'daily' THEN interval '1 day' WHEN 'weekly' THEN interval '7 days'
            WHEN 'biweekly' THEN interval '14 days' ELSE interval '30 days' END) - interval '1 hour' <= now()
  LOOP
    FOR m IN
      SELECT em.id, em.user_id FROM public.esusu_members em
      WHERE em.group_id = g.id AND NOT em.removed AND em.auto_debit
        AND NOT EXISTS (SELECT 1 FROM public.esusu_contributions ec
                        WHERE ec.group_id = g.id AND ec.member_id = em.id AND ec.cycle_number = g.current_cycle)
    LOOP
      BEGIN
        v_ok := public.esusu_contribute(m.user_id, g.id, m.id, g.contribution_amount_kobo, g.current_cycle);
        IF v_ok THEN v_paid := v_paid + 1; ELSE v_short := v_short + 1; END IF;
      EXCEPTION WHEN others THEN
        v_short := v_short + 1;
        RAISE WARNING 'esusu auto-contribute member %: %', m.id, SQLERRM;
      END;
    END LOOP;
    v_res := public.process_esusu_payout(g.id);
    IF v_res->>'ok' = 'true' THEN v_payouts := v_payouts + 1; END IF;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'paid', v_paid, 'short_of_funds', v_short, 'payouts', v_payouts);
END;
$$;
REVOKE ALL ON FUNCTION public.esusu_auto_contribute() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.esusu_auto_contribute() TO service_role;

-- ── 3. Admin volume: + Goals, Ajo/circles, cooperative dues ───────────────────
-- Money going IN to each product is counted once (the contribution leg); payouts back out
-- are not added on top, so the same naira isn't counted twice. Co-op dues are written as
-- esusu_contribute with metadata.coop_id (116), so they are split out by that key.
DROP FUNCTION IF EXISTS public.admin_tx_volume();
CREATE OR REPLACE FUNCTION public.admin_tx_volume()
RETURNS TABLE (
  total_deposits_kobo bigint, total_withdrawals_kobo bigint, total_vault_saves_kobo bigint,
  total_loans_disbursed_kobo bigint, total_loans_repaid_kobo bigint,
  total_investments_kobo bigint,
  total_transfers_kobo bigint,
  total_tx_count bigint, pending_count bigint,
  total_goal_saves_kobo bigint, total_circle_contrib_kobo bigint, total_coop_dues_kobo bigint
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    COALESCE(SUM(CASE WHEN type = 'deposit'           AND status = 'completed' THEN amount_kobo ELSE 0 END), 0)::bigint,
    COALESCE(SUM(CASE WHEN type = 'withdrawal'        AND status = 'completed' THEN amount_kobo ELSE 0 END), 0)::bigint,
    COALESCE(SUM(CASE WHEN type = 'save_to_vault'     AND status = 'completed' THEN amount_kobo ELSE 0 END), 0)::bigint,
    COALESCE(SUM(CASE WHEN type = 'loan_disbursement' AND status = 'completed' THEN amount_kobo ELSE 0 END), 0)::bigint,
    COALESCE(SUM(CASE WHEN type = 'loan_repayment'    AND status = 'completed' THEN amount_kobo ELSE 0 END), 0)::bigint,
    COALESCE(SUM(CASE WHEN type = 'investment'  AND status = 'completed' THEN amount_kobo
                      WHEN type = 'equity_sell' AND status = 'completed' THEN FLOOR(amount_usdc_micro / 10000)
                      ELSE 0 END), 0)::bigint,
    COALESCE(SUM(CASE WHEN type IN ('transfer_out','pawa_pay') AND status = 'completed' THEN amount_kobo ELSE 0 END), 0)::bigint,
    (SELECT COUNT(*) FROM public.transactions WHERE status = 'completed')::bigint,
    (SELECT COUNT(*) FROM public.transactions WHERE status = 'pending')::bigint,
    COALESCE(SUM(CASE WHEN type = 'goal_contribute' AND status = 'completed' THEN amount_kobo ELSE 0 END), 0)::bigint,
    COALESCE(SUM(CASE WHEN type = 'esusu_contribute' AND status = 'completed' AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'coop_id')
                      THEN amount_kobo ELSE 0 END), 0)::bigint,
    COALESCE(SUM(CASE WHEN type = 'esusu_contribute' AND status = 'completed' AND COALESCE(metadata, '{}'::jsonb) ? 'coop_id'
                      THEN amount_kobo ELSE 0 END), 0)::bigint
  FROM public.transactions;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
REVOKE ALL ON FUNCTION public.admin_tx_volume() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_tx_volume() TO service_role;

-- ── 4. Admin revenue: fees + the yield spread ─────────────────────────────────
-- Same columns as 066 first (so nothing that reads them changes meaning), except the three
-- totals now include the yield spread, plus total_yield_spread_kobo on the end.
DROP FUNCTION IF EXISTS public.admin_fee_summary();
CREATE OR REPLACE FUNCTION public.admin_fee_summary()
RETURNS TABLE (
  total_fees_kobo bigint, total_onramp_fees bigint, total_offramp_fees bigint,
  total_penalty_fees bigint, total_loan_fees bigint, total_investment_fees bigint,
  fee_count bigint, today_fees_kobo bigint, this_month_fees_kobo bigint,
  total_yield_spread_kobo bigint
) AS $$
DECLARE
  s_total bigint; s_today bigint; s_month bigint;
BEGIN
  SELECT
    COALESCE(floor(SUM(amount_usdc_micro) / 10000), 0)::bigint,
    COALESCE(floor(SUM(CASE WHEN created_at::date = current_date THEN amount_usdc_micro ELSE 0 END) / 10000), 0)::bigint,
    COALESCE(floor(SUM(CASE WHEN date_trunc('month', created_at) = date_trunc('month', current_date) THEN amount_usdc_micro ELSE 0 END) / 10000), 0)::bigint
  INTO s_total, s_today, s_month
  FROM public.revenue_journal WHERE revenue_type = 'yield_spread';

  RETURN QUERY
  SELECT
    (COALESCE(SUM(fee_amount_kobo), 0) + s_total)::bigint,
    COALESCE(SUM(CASE WHEN fee_type = 'ramp_onramp' THEN fee_amount_kobo ELSE 0 END), 0)::bigint,
    COALESCE(SUM(CASE WHEN fee_type = 'ramp_offramp' THEN fee_amount_kobo ELSE 0 END), 0)::bigint,
    COALESCE(SUM(CASE WHEN fee_type IN ('vault_lock_penalty', 'esusu_penalty', 'goal_break_penalty', 'xauto_spread') THEN fee_amount_kobo ELSE 0 END), 0)::bigint,
    COALESCE(SUM(CASE WHEN fee_type IN ('loan_origination', 'loan_interest') THEN fee_amount_kobo ELSE 0 END), 0)::bigint,
    COALESCE(SUM(CASE WHEN fee_type IN ('equity_sell', 'equity_buy') THEN fee_amount_kobo ELSE 0 END), 0)::bigint,
    COUNT(*)::bigint,
    (COALESCE(SUM(CASE WHEN created_at::date = current_date THEN fee_amount_kobo ELSE 0 END), 0) + s_today)::bigint,
    (COALESCE(SUM(CASE WHEN date_trunc('month', created_at) = date_trunc('month', current_date) THEN fee_amount_kobo ELSE 0 END), 0) + s_month)::bigint,
    s_total
  FROM public.platform_fees
  WHERE fee_type IN ('ramp_onramp','ramp_offramp','vault_lock_penalty','esusu_penalty','goal_break_penalty','xauto_spread','loan_origination','loan_interest','equity_sell','equity_buy');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
REVOKE ALL ON FUNCTION public.admin_fee_summary() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_fee_summary() TO service_role;
