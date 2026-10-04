-- 114_liquidation_unpriced_holding.sql
--
-- Two fixes before borrowing ships: a liquidation that takes a stock and credits nothing for it,
-- and the missing column that has been silently killing the loan-due reminder.
--
-- ── 1. A HOLDING WITH NO CACHED PRICE IS SEIZED FOR ZERO ─────────────────────
--
-- 042's seizure loop:
--
--   FOR r IN SELECT h.id, h.shares, COALESCE(p.price_ngn_micro,0) AS px
--            FROM portfolio_holdings h LEFT JOIN equity_prices p ON p.symbol = h.symbol
--            WHERE h.pledged_loan_id = v_loan.id AND h.shares > 0 LOOP
--     v_seized := v_seized + FLOOR(r.shares * r.px);
--     UPDATE portfolio_holdings SET shares = 0, invested_cngn_micro = 0, ... ;
--
-- A LEFT JOIN with no matching price row gives px = 0. The shares are zeroed either way, so the
-- position transfers to the platform and is sold operationally, but `v_seized` counts it as nothing.
-- The borrower loses the stock and gets no credit against the debt, and no surplus for it. The
-- platform recovers the real value. That asymmetry is the bug.
--
-- `equity_prices` is only populated for symbols somebody has looked at — refreshUserEquityPrices
-- runs on the loans route and the loan-maintenance cron, both best-effort — so a missing row is an
-- ordinary state, not a corrupt one.
--
-- The fix values an unpriced position at its cost basis, `invested_cngn_micro`. That is a stored
-- figure, it is what the borrower actually paid, and migration 068 keeps it proportional to the
-- remaining shares after a partial sale, so it is the right number for the shares still held. Any
-- price we do have still wins, stale or not, which is 042's behaviour and is left alone.
--
-- NOT CHANGED, because it is not a bug: `v_owed := v_loan.principal_micro +
-- v_loan.accrued_interest_micro + v_int`. v_loan is a record snapshot taken before the UPDATE, so
-- its accrued figure is the pre-update one and adding v_int reproduces the post-update total exactly.
-- Verified against a live Postgres rather than reasoned about. Removing the `+ v_int` would
-- under-count the debt by one cron interval of interest.
--
-- ── 2. loans.due_reminder_sent DOES NOT EXIST ────────────────────────────────
--
-- backend/src/routes/cron/loan-maintenance/route.ts filters `.eq('due_reminder_sent', false)` and
-- then writes `.update({ due_reminder_sent: true })`. Its comment says "mig 051"; there is no
-- migration 051 and the column appears in no SQL file. So the whole due-soon push block throws on
-- every run, is swallowed into `out.reminderError`, and no borrower has ever been reminded that a
-- loan is about to fall due. Adding the column is all it needs.
--
-- MANUAL STEP: none. One column added with a default, one function replaced.

-- ── the missing column ───────────────────────────────────────────────────────
ALTER TABLE public.loans
  ADD COLUMN IF NOT EXISTS due_reminder_sent boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.loans.due_reminder_sent IS
  'Set once the "loan due in <= 3 days" push has been sent, so it goes out once per loan. Read and '
  'written by /api/cron/loan-maintenance, which errored on every run until 114 added this.';

-- ── liquidate_overdue_loans: body from 042, unpriced seizure valued at cost ──
CREATE OR REPLACE FUNCTION public.liquidate_overdue_loans()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_loan public.loans%rowtype;
  v_grace numeric := public._loan_setting('loan_liquidation_grace_days', 7);
  v_thresh numeric := public._loan_setting('loan_liquidation_threshold', 85);
  v_max_age int := public._loan_setting('loan_equity_price_max_age_min', 360)::int;
  v_secs numeric; v_int bigint; v_owed bigint; v_collateral bigint; v_seized bigint; v_surplus bigint;
  v_overdue boolean; r record; v_n int := 0; v_val bigint;
BEGIN
  FOR v_loan IN SELECT * FROM public.loans WHERE status='active' FOR UPDATE LOOP
    v_secs := EXTRACT(EPOCH FROM (now() - v_loan.last_accrued_at));
    v_int  := FLOOR(v_loan.principal_micro * v_loan.apr_percent / 100.0 * v_secs / 31557600.0);
    UPDATE public.loans SET accrued_interest_micro = accrued_interest_micro + v_int, last_accrued_at = now() WHERE id = v_loan.id;
    -- v_loan is a pre-UPDATE snapshot, so this is the post-UPDATE total, not a double count.
    v_owed := v_loan.principal_micro + v_loan.accrued_interest_micro + v_int;

    -- Current collateral value: fixed savings principal + fresh equity value.
    SELECT COALESCE(SUM(amount_usdc_micro),0) INTO v_collateral
    FROM public.savings_locks WHERE pledged_loan_id = v_loan.id AND status='active';
    SELECT v_collateral + COALESCE(SUM(FLOOR(h.shares * p.price_ngn_micro)),0)::bigint INTO v_collateral
    FROM public.portfolio_holdings h JOIN public.equity_prices p ON p.symbol=h.symbol
    WHERE h.pledged_loan_id = v_loan.id AND h.shares > 0
      AND p.updated_at > now() - make_interval(mins => v_max_age);

    v_overdue := now() > v_loan.due_date + make_interval(days => v_grace::int);

    IF v_overdue OR (v_collateral > 0 AND v_owed * 100 >= v_collateral * v_thresh) THEN
      v_seized := 0;
      -- Seize fixed-savings locks in full.
      FOR r IN SELECT id, amount_usdc_micro FROM public.savings_locks WHERE pledged_loan_id=v_loan.id AND status='active' LOOP
        UPDATE public.savings_locks SET status='liquidated', withdrawn_at=now(), pledged_loan_id=NULL WHERE id=r.id;
        v_seized := v_seized + r.amount_usdc_micro;
      END LOOP;
      -- Seize equity holdings at cached value (0 out the shares; broker sale is operational).
      FOR r IN SELECT h.id, h.shares, h.invested_cngn_micro, COALESCE(p.price_ngn_micro,0) AS px
               FROM public.portfolio_holdings h LEFT JOIN public.equity_prices p ON p.symbol=h.symbol
               WHERE h.pledged_loan_id=v_loan.id AND h.shares > 0 LOOP
        -- 114: no cached price means value it at what the borrower paid, not at nothing. The shares
        -- leave their account either way, so crediting zero would take the asset for free.
        IF r.px > 0 THEN
          v_val := FLOOR(r.shares * r.px);
        ELSE
          v_val := r.invested_cngn_micro;
        END IF;
        v_seized := v_seized + v_val;
        UPDATE public.portfolio_holdings SET shares=0, invested_cngn_micro=0, pledged_loan_id=NULL, updated_at=now() WHERE id=r.id;
      END LOOP;

      v_surplus := GREATEST(0, v_seized - v_owed);
      IF v_surplus > 0 THEN
        UPDATE public.wallets SET usdc_balance_micro = usdc_balance_micro + v_surplus, updated_at=now() WHERE user_id=v_loan.user_id;
      END IF;
      IF v_loan.accrued_interest_micro > 0 THEN
        UPDATE public.platform_settings SET value=(COALESCE(value::bigint,0)+FLOOR(v_loan.accrued_interest_micro/10000))::text WHERE key='platform_revenue_kobo';
      END IF;

      UPDATE public.loans SET status='liquidated', closed_at=now(), principal_micro=0, accrued_interest_micro=0 WHERE id=v_loan.id;
      INSERT INTO public.transactions (user_id, type, direction, amount_kobo, amount_usdc_micro, description, status)
      VALUES (v_loan.user_id, 'loan_liquidation', 'debit', FLOOR(v_owed/10000), v_owed,
              format('Loan liquidated — collateral seized to clear ₦%s%s', (v_owed/1e6)::numeric(20,2),
                     CASE WHEN v_surplus>0 THEN format(', ₦%s returned', (v_surplus/1e6)::numeric(20,2)) ELSE '' END), 'completed');
      v_n := v_n + 1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('liquidated', v_n);
END;
$$;

GRANT EXECUTE ON FUNCTION public.liquidate_overdue_loans() TO service_role;
REVOKE ALL ON FUNCTION public.liquidate_overdue_loans() FROM PUBLIC, anon, authenticated;
