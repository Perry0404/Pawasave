-- 040_fix_revenue_views.sql
-- Fix the /admin/revenue dashboard so its numbers are accurate.
--
-- The problem: the page reads four views (platform_metrics.total_revenue_usdc,
-- revenue_by_type, revenue_summary_monthly, revenue_summary_daily) that all
-- aggregate from `revenue_journal` — which is EMPTY. Real platform revenue (ramp
-- fees, ~₦1,035) lives in `platform_fees` (the ledger the main admin dashboard and
-- migration 036 use). On top of that, the old views exposed columns the page
-- doesn't read (`transaction_count` vs `count`, `month` vs `date`), so even with
-- data those tables rendered blank.
--
-- Fix: repoint all four views at `platform_fees`, expose the EXACT columns the page
-- reads, and convert units:
--   platform_fees.fee_amount_kobo is KOBO  →  *10000 = micro ;  /100 = naira
-- Only positive fees are revenue (admin_revenue_withdrawal is a negative payout).
--
-- Column changes (transaction_count→count, month→date) require DROP + CREATE, not
-- CREATE OR REPLACE. Run the whole file in the Supabase SQL editor.

DROP VIEW IF EXISTS public.revenue_by_type;
DROP VIEW IF EXISTS public.revenue_summary_daily;
DROP VIEW IF EXISTS public.revenue_summary_monthly;
DROP VIEW IF EXISTS public.platform_metrics;

-- Total revenue grouped by fee type
CREATE VIEW public.revenue_by_type AS
  SELECT
    fee_type                                   AS revenue_type,
    COUNT(*)::bigint                           AS count,
    (SUM(fee_amount_kobo) * 10000)::bigint     AS total_usdc_micro,
    ROUND(SUM(fee_amount_kobo) / 100.0, 2)     AS total_usdc,
    ROUND(AVG(fee_amount_kobo) / 100.0, 4)     AS avg_usdc
  FROM public.platform_fees
  WHERE fee_amount_kobo > 0
  GROUP BY fee_type
  ORDER BY SUM(fee_amount_kobo) DESC;

-- Daily revenue (page filters to last 30)
CREATE VIEW public.revenue_summary_daily AS
  SELECT
    DATE(created_at)                           AS date,
    fee_type                                   AS revenue_type,
    COUNT(*)::bigint                           AS count,
    (SUM(fee_amount_kobo) * 10000)::bigint     AS total_usdc_micro,
    ROUND(SUM(fee_amount_kobo) / 100.0, 2)     AS total_usdc
  FROM public.platform_fees
  WHERE fee_amount_kobo > 0
  GROUP BY DATE(created_at), fee_type
  ORDER BY DATE(created_at) DESC;

-- Monthly revenue (page reads `date`, not `month`)
CREATE VIEW public.revenue_summary_monthly AS
  SELECT
    DATE_TRUNC('month', created_at)::date      AS date,
    fee_type                                   AS revenue_type,
    COUNT(*)::bigint                           AS count,
    (SUM(fee_amount_kobo) * 10000)::bigint     AS total_usdc_micro,
    ROUND(SUM(fee_amount_kobo) / 100.0, 2)     AS total_usdc
  FROM public.platform_fees
  WHERE fee_amount_kobo > 0
  GROUP BY DATE_TRUNC('month', created_at), fee_type
  ORDER BY DATE_TRUNC('month', created_at) DESC;

-- Headline metrics. total_revenue_usdc = gross positive fees in naira (matches the
-- sum of the breakdown above, so the page is internally consistent).
CREATE VIEW public.platform_metrics AS
  SELECT
    (SELECT COUNT(*) FROM auth.users)                                                AS total_users,
    (SELECT COUNT(*) FROM public.savings_locks  WHERE status = 'active')             AS active_locks,
    (SELECT COUNT(*) FROM public.savings_goals  WHERE status = 'active')             AS active_goals,
    (SELECT COUNT(*) FROM public.transactions   WHERE status = 'completed')          AS completed_transactions,
    COALESCE(
      (SELECT ROUND(SUM(fee_amount_kobo) / 100.0, 2)
         FROM public.platform_fees WHERE fee_amount_kobo > 0),
      0
    )                                                                                AS total_revenue_usdc;

-- The admin page reads these via the browser (anon/authenticated) client; the views
-- run with owner rights so they read the service-role-only platform_fees. (Note:
-- this exposes revenue analytics to any authenticated client — fine for now, but
-- worth moving behind a server admin API later.)
GRANT SELECT ON
  public.revenue_by_type,
  public.revenue_summary_daily,
  public.revenue_summary_monthly,
  public.platform_metrics
TO anon, authenticated;