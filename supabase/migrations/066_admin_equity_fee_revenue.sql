-- 066_admin_equity_fee_revenue.sql
-- Bring tokenized-stock fees into the admin dashboard's revenue side.
--
-- Bug: the ₦500 flat sell fee books to platform_fees as 'equity_sell' (migration 062)
-- and correctly bumps the withdrawable counter (platform_revenue_kobo), so it shows on
-- the /admin/revenue page (revenue_by_type view = ₦3,051). But admin_fee_summary() and
-- admin_recent_fees() hardcode a WHERE fee_type IN (...) list that OMITS 'equity_sell'
-- (and 'equity_buy'), so the main /admin dashboard's "Total Revenue" card dropped the
-- ₦500 (showed ₦2,551, count 30) and never listed the sell fee in Recent Fees.
--
-- Fix: add a total_investment_fees bucket to admin_fee_summary and include the equity
-- fee types everywhere the earning list appears. No data change — the fee rows already
-- exist and the counter is already correct; this only makes the summary read them.

-- 1) admin_fee_summary — add total_investment_fees; count equity fees in the total.
--    DROP first: output columns change, so CREATE OR REPLACE alone can't do it.
DROP FUNCTION IF EXISTS public.admin_fee_summary();
CREATE OR REPLACE FUNCTION public.admin_fee_summary()
RETURNS TABLE (
  total_fees_kobo bigint, total_onramp_fees bigint, total_offramp_fees bigint,
  total_penalty_fees bigint, total_loan_fees bigint, total_investment_fees bigint,
  fee_count bigint, today_fees_kobo bigint, this_month_fees_kobo bigint
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    COALESCE(SUM(fee_amount_kobo), 0)::bigint,
    COALESCE(SUM(CASE WHEN fee_type = 'ramp_onramp' THEN fee_amount_kobo ELSE 0 END), 0)::bigint,
    COALESCE(SUM(CASE WHEN fee_type = 'ramp_offramp' THEN fee_amount_kobo ELSE 0 END), 0)::bigint,
    COALESCE(SUM(CASE WHEN fee_type IN ('vault_lock_penalty', 'esusu_penalty', 'goal_break_penalty', 'xauto_spread') THEN fee_amount_kobo ELSE 0 END), 0)::bigint,
    COALESCE(SUM(CASE WHEN fee_type IN ('loan_origination', 'loan_interest') THEN fee_amount_kobo ELSE 0 END), 0)::bigint,
    COALESCE(SUM(CASE WHEN fee_type IN ('equity_sell', 'equity_buy') THEN fee_amount_kobo ELSE 0 END), 0)::bigint,
    COUNT(*)::bigint,
    COALESCE(SUM(CASE WHEN created_at::date = current_date THEN fee_amount_kobo ELSE 0 END), 0)::bigint,
    COALESCE(SUM(CASE WHEN date_trunc('month', created_at) = date_trunc('month', current_date) THEN fee_amount_kobo ELSE 0 END), 0)::bigint
  FROM public.platform_fees
  WHERE fee_type IN ('ramp_onramp','ramp_offramp','vault_lock_penalty','esusu_penalty','goal_break_penalty','xauto_spread','loan_origination','loan_interest','equity_sell','equity_buy');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION public.admin_fee_summary() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_fee_summary() TO service_role;

-- 2) admin_tx_volume — count tokenized-stock SELLS in investment volume too.
--    057 added total_investments_kobo but only summed type='investment' (the BUY leg).
--    Sells settle as type='equity_sell' with amount_kobo=0 (the net cNGN credited lives
--    in amount_usdc_micro), so they were invisible to volume. Fold them in via the micro
--    column. Output columns are identical to 057 — no frontend change needed.
DROP FUNCTION IF EXISTS public.admin_tx_volume();
CREATE OR REPLACE FUNCTION public.admin_tx_volume()
RETURNS TABLE (
  total_deposits_kobo bigint, total_withdrawals_kobo bigint, total_vault_saves_kobo bigint,
  total_loans_disbursed_kobo bigint, total_loans_repaid_kobo bigint,
  total_investments_kobo bigint,
  total_tx_count bigint, pending_count bigint
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    COALESCE(SUM(CASE WHEN type = 'deposit'           AND status = 'completed' THEN amount_kobo ELSE 0 END), 0)::bigint,
    COALESCE(SUM(CASE WHEN type = 'withdrawal'        AND status = 'completed' THEN amount_kobo ELSE 0 END), 0)::bigint,
    COALESCE(SUM(CASE WHEN type = 'save_to_vault'     AND status = 'completed' THEN amount_kobo ELSE 0 END), 0)::bigint,
    COALESCE(SUM(CASE WHEN type = 'loan_disbursement' AND status = 'completed' THEN amount_kobo ELSE 0 END), 0)::bigint,
    COALESCE(SUM(CASE WHEN type = 'loan_repayment'    AND status = 'completed' THEN amount_kobo ELSE 0 END), 0)::bigint,
    -- Buys carry the invested amount in amount_kobo; sells carry the net cNGN in amount_usdc_micro.
    COALESCE(SUM(CASE WHEN type = 'investment'  AND status = 'completed' THEN amount_kobo
                      WHEN type = 'equity_sell' AND status = 'completed' THEN FLOOR(amount_usdc_micro / 10000)
                      ELSE 0 END), 0)::bigint,
    (SELECT COUNT(*) FROM public.transactions WHERE status = 'completed')::bigint,
    (SELECT COUNT(*) FROM public.transactions WHERE status = 'pending')::bigint
  FROM public.transactions;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.admin_tx_volume() TO service_role;

-- 3) admin_recent_fees — list the equity fees too.
CREATE OR REPLACE FUNCTION public.admin_recent_fees(p_limit int DEFAULT 50)
RETURNS TABLE (
  id uuid, user_id uuid, transaction_ref text, fee_type text,
  gross_amount_kobo bigint, fee_amount_kobo bigint, fee_percent numeric, created_at timestamptz
) AS $$
BEGIN
  RETURN QUERY
  SELECT f.id, f.user_id, f.transaction_ref, f.fee_type,
         f.gross_amount_kobo, f.fee_amount_kobo, f.fee_percent, f.created_at
  FROM public.platform_fees f
  WHERE f.fee_type IN ('ramp_onramp','ramp_offramp','vault_lock_penalty','esusu_penalty','goal_break_penalty','xauto_spread','loan_origination','loan_interest','equity_sell','equity_buy')
  ORDER BY f.created_at DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
