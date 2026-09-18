-- 042_asset_backed_lending.sql
-- Custodial, in-app asset-backed lending. Users borrow cNGN against in-app assets
-- WITHOUT touching DeFi: they tap Borrow, their assets show as collateral, they
-- sign an agreement, see their limit, and receive cNGN in their spendable balance.
-- On default the collateral is seized to repay the loan.
--
-- Collateral (v1):
--   * STOCKS (portfolio_holdings) — the headline case: borrow against tokenized
--     equity without selling it. Valued from a price cache (equity_prices) the app
--     refreshes at borrow time, because a DB function can't call the price API.
--   * FIXED SAVINGS (savings_locks) — the fallback for users without stocks. cNGN
--     collateral for a cNGN loan: inherently over-collateralised and instantly
--     liquidated in-DB, and it lets a user get liquidity WITHOUT breaking the lock.
--
-- Economics: borrowers pay interest → platform_revenue_kobo, which is the yield the
-- savings side is paid from. Your own depositors become the borrower base — the
-- borrow demand the pool needs, sourced internally.
--
-- All money moves are SECURITY DEFINER RPCs with an auth.uid() guard. Idempotent.

-- ── Config (overridable in platform_settings) ────────────────────────────────
INSERT INTO public.platform_settings (key, value) VALUES
  ('loan_ltv_fixed_savings',        '70'),   -- borrow up to 70% of pledged lock principal
  ('loan_ltv_equity',               '40'),   -- stocks are volatile → lower LTV
  ('loan_apr_percent',              '24'),   -- annual interest charged to the borrower
  ('loan_origination_fee_percent',  '1'),    -- one-off fee, deducted from disbursement
  ('loan_liquidation_threshold',    '85'),   -- liquidate when debt >= this % of collateral
  ('loan_liquidation_grace_days',   '7'),    -- ...or this many days past the due date
  ('loan_equity_price_max_age_min', '360'),  -- ignore equity priced older than this (6h)
  ('loan_max_tenor_days',           '180'),
  ('usd_ngn_rate',                  '1600'),  -- USD→NGN for pricing USD-quoted stocks in cNGN
  ('loan_agreement_version',        'v1-2026-07')
ON CONFLICT (key) DO NOTHING;

-- ── Schema ───────────────────────────────────────────────────────────────────
-- Cached cNGN value of ONE share, refreshed by the app (Yahoo USD price × NGN/USD).
CREATE TABLE IF NOT EXISTS public.equity_prices (
  symbol          text PRIMARY KEY,
  price_ngn_micro bigint NOT NULL,          -- cNGN (6dp) value of a single share
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.loans (
  id                      uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id                 uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  principal_micro         bigint NOT NULL,
  apr_percent             numeric(6,2) NOT NULL,
  origination_fee_micro   bigint NOT NULL DEFAULT 0,
  accrued_interest_micro  bigint NOT NULL DEFAULT 0,
  last_accrued_at         timestamptz NOT NULL DEFAULT now(),
  borrowed_at             timestamptz NOT NULL DEFAULT now(),
  due_date                timestamptz NOT NULL,
  status                  text NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active','repaid','liquidated')),
  agreement_version       text NOT NULL,
  agreement_signed_at     timestamptz NOT NULL DEFAULT now(),
  closed_at               timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_loan_per_user
  ON public.loans (user_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS public.loan_collateral (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  loan_id             uuid NOT NULL REFERENCES public.loans(id) ON DELETE CASCADE,
  asset_type          text NOT NULL CHECK (asset_type IN ('fixed_savings','equity','cngn')),
  asset_ref           text NOT NULL,                             -- savings_locks.id / portfolio_holdings.id
  pledged_value_micro bigint NOT NULL,
  ltv_percent         numeric(6,2) NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_loan_collateral_loan ON public.loan_collateral (loan_id);

-- Pledge markers on the assets themselves → a pledged asset can't be withdrawn/sold.
ALTER TABLE public.savings_locks      ADD COLUMN IF NOT EXISTS pledged_loan_id uuid;
ALTER TABLE public.portfolio_holdings ADD COLUMN IF NOT EXISTS pledged_loan_id uuid;

ALTER TABLE public.savings_locks DROP CONSTRAINT IF EXISTS savings_locks_status_check;
ALTER TABLE public.savings_locks ADD CONSTRAINT savings_locks_status_check
  CHECK (status IN ('active','matured','withdrawn','early_withdrawn','liquidated'));

ALTER TABLE public.loans           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loan_collateral ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.equity_prices   ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS loans_owner_read ON public.loans;
CREATE POLICY loans_owner_read ON public.loans FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS loan_collateral_owner_read ON public.loan_collateral;
CREATE POLICY loan_collateral_owner_read ON public.loan_collateral FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.loans l WHERE l.id = loan_id AND l.user_id = auth.uid()));
DROP POLICY IF EXISTS equity_prices_read ON public.equity_prices;
CREATE POLICY equity_prices_read ON public.equity_prices FOR SELECT USING (true);

-- ── helpers ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._loan_setting(p_key text, p_default numeric)
RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT value::numeric FROM public.platform_settings WHERE key = p_key), p_default);
$$;

-- cNGN value of a user's un-pledged, freshly-priced equity holdings.
CREATE OR REPLACE FUNCTION public._loan_equity_value(p_user_id uuid)
RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT COALESCE(SUM(FLOOR(h.shares * p.price_ngn_micro)), 0)::bigint
  FROM public.portfolio_holdings h
  JOIN public.equity_prices p ON p.symbol = h.symbol
  WHERE h.user_id = p_user_id
    AND h.shares > 0
    AND h.pledged_loan_id IS NULL
    AND p.updated_at > now() - make_interval(mins => public._loan_setting('loan_equity_price_max_age_min', 360)::int);
$$;

-- ── loan_borrow_limit ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.loan_borrow_limit(p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_ltv_fs   numeric := public._loan_setting('loan_ltv_fixed_savings', 70);
  v_ltv_eq   numeric := public._loan_setting('loan_ltv_equity', 40);
  v_fs       bigint  := 0;
  v_eq       bigint  := 0;
  v_limit    bigint;
  v_has_loan boolean;
  v_debt     bigint  := 0;
  v_loan     public.loans%rowtype;
BEGIN
  SELECT COALESCE(SUM(amount_usdc_micro), 0) INTO v_fs
  FROM public.savings_locks
  WHERE user_id = p_user_id AND status = 'active' AND pledged_loan_id IS NULL;

  v_eq := public._loan_equity_value(p_user_id);

  v_limit := FLOOR(v_fs * v_ltv_fs / 100.0) + FLOOR(v_eq * v_ltv_eq / 100.0);

  SELECT * INTO v_loan FROM public.loans WHERE user_id = p_user_id AND status = 'active' LIMIT 1;
  v_has_loan := FOUND;
  IF v_has_loan THEN v_debt := v_loan.principal_micro + v_loan.accrued_interest_micro; END IF;

  RETURN jsonb_build_object(
    'fixed_savings_micro',  v_fs,
    'equity_micro',         v_eq,
    'ltv_fixed_savings',    v_ltv_fs,
    'ltv_equity',           v_ltv_eq,
    'borrow_limit_micro',   v_limit,
    'available_micro',      CASE WHEN v_has_loan THEN 0 ELSE v_limit END,
    'has_active_loan',      v_has_loan,
    'current_debt_micro',   v_debt
  );
END;
$$;

-- ── create_loan ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_loan(
  p_user_id uuid, p_amount_micro bigint, p_tenor_days int, p_agreement_version text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_apr       numeric := public._loan_setting('loan_apr_percent', 24);
  v_ltv_fs    numeric := public._loan_setting('loan_ltv_fixed_savings', 70);
  v_ltv_eq    numeric := public._loan_setting('loan_ltv_equity', 40);
  v_fee_pct   numeric := public._loan_setting('loan_origination_fee_percent', 1);
  v_max_tenor numeric := public._loan_setting('loan_max_tenor_days', 180);
  v_max_age   int     := public._loan_setting('loan_equity_price_max_age_min', 360)::int;
  v_fs bigint := 0; v_eq bigint := 0; v_limit bigint; v_fee bigint; v_net bigint;
  v_loan_id uuid; v_due timestamptz; r record; v_price bigint; v_val bigint;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN RAISE EXCEPTION 'forbidden'; END IF;
  IF p_amount_micro IS NULL OR p_amount_micro <= 0 THEN RAISE EXCEPTION 'Amount must be positive'; END IF;
  IF p_tenor_days IS NULL OR p_tenor_days <= 0 OR p_tenor_days > v_max_tenor THEN
    RAISE EXCEPTION 'Loan term must be between 1 and % days', v_max_tenor;
  END IF;
  IF p_agreement_version IS NULL OR length(p_agreement_version) = 0 THEN
    RAISE EXCEPTION 'You must accept the loan agreement';
  END IF;
  IF (SELECT kyc_status FROM public.profiles WHERE id = p_user_id) IS DISTINCT FROM 'verified' THEN
    RAISE EXCEPTION 'Complete KYC to borrow';
  END IF;
  IF EXISTS (SELECT 1 FROM public.loans WHERE user_id = p_user_id AND status = 'active') THEN
    RAISE EXCEPTION 'You already have an active loan — repay it before borrowing again';
  END IF;

  -- Lock eligible collateral rows.
  PERFORM 1 FROM public.savings_locks WHERE user_id = p_user_id AND status='active' AND pledged_loan_id IS NULL FOR UPDATE;
  PERFORM 1 FROM public.portfolio_holdings WHERE user_id = p_user_id AND shares > 0 AND pledged_loan_id IS NULL FOR UPDATE;

  SELECT COALESCE(SUM(amount_usdc_micro),0) INTO v_fs
  FROM public.savings_locks WHERE user_id=p_user_id AND status='active' AND pledged_loan_id IS NULL;
  v_eq := public._loan_equity_value(p_user_id);

  v_limit := FLOOR(v_fs * v_ltv_fs / 100.0) + FLOOR(v_eq * v_ltv_eq / 100.0);
  IF v_limit <= 0 THEN
    RAISE EXCEPTION 'You have no eligible collateral. Buy a stock or lock a fixed savings to borrow against it.';
  END IF;
  IF p_amount_micro > v_limit THEN
    RAISE EXCEPTION 'Amount exceeds your borrow limit of % cNGN', (v_limit/1e6)::numeric(20,2);
  END IF;

  v_fee := FLOOR(p_amount_micro * v_fee_pct / 100.0);
  v_net := p_amount_micro - v_fee;
  v_due := now() + (p_tenor_days || ' days')::interval;

  INSERT INTO public.loans (user_id, principal_micro, apr_percent, origination_fee_micro, due_date, agreement_version)
  VALUES (p_user_id, p_amount_micro, v_apr, v_fee, v_due, p_agreement_version)
  RETURNING id INTO v_loan_id;

  -- Pledge fixed-savings locks.
  FOR r IN SELECT id, amount_usdc_micro FROM public.savings_locks
           WHERE user_id=p_user_id AND status='active' AND pledged_loan_id IS NULL LOOP
    UPDATE public.savings_locks SET pledged_loan_id = v_loan_id WHERE id = r.id;
    INSERT INTO public.loan_collateral (loan_id, asset_type, asset_ref, pledged_value_micro, ltv_percent)
    VALUES (v_loan_id, 'fixed_savings', r.id::text, r.amount_usdc_micro, v_ltv_fs);
  END LOOP;

  -- Pledge freshly-priced equity holdings (value at current cached price).
  FOR r IN SELECT h.id, h.shares, p.price_ngn_micro
           FROM public.portfolio_holdings h JOIN public.equity_prices p ON p.symbol = h.symbol
           WHERE h.user_id=p_user_id AND h.shares > 0 AND h.pledged_loan_id IS NULL
             AND p.updated_at > now() - make_interval(mins => v_max_age) LOOP
    v_val := FLOOR(r.shares * r.price_ngn_micro);
    UPDATE public.portfolio_holdings SET pledged_loan_id = v_loan_id WHERE id = r.id;
    INSERT INTO public.loan_collateral (loan_id, asset_type, asset_ref, pledged_value_micro, ltv_percent)
    VALUES (v_loan_id, 'equity', r.id::text, v_val, v_ltv_eq);
  END LOOP;

  UPDATE public.wallets SET usdc_balance_micro = usdc_balance_micro + v_net, updated_at = now() WHERE user_id = p_user_id;

  IF v_fee > 0 THEN
    INSERT INTO public.platform_fees (user_id, transaction_ref, fee_type, gross_amount_kobo, fee_amount_kobo, fee_percent)
    VALUES (p_user_id, v_loan_id::text, 'loan_origination', FLOOR(p_amount_micro/10000), FLOOR(v_fee/10000), v_fee_pct);
    UPDATE public.platform_settings SET value = (COALESCE(value::bigint,0) + FLOOR(v_fee/10000))::text WHERE key='platform_revenue_kobo';
  END IF;

  INSERT INTO public.transactions (user_id, type, direction, amount_kobo, amount_usdc_micro, description, status)
  VALUES (p_user_id, 'loan_disbursement', 'credit', FLOOR(v_net/10000), v_net,
          format('Loan of ₦%s at %s%% APR, due %s', (v_net/1e6)::numeric(20,2), v_apr, to_char(v_due,'DD Mon YYYY')), 'completed');

  RETURN jsonb_build_object('loan_id', v_loan_id, 'principal_micro', p_amount_micro,
    'net_disbursed_micro', v_net, 'fee_micro', v_fee, 'apr_percent', v_apr, 'due_date', v_due);
END;
$$;

-- ── repay_loan ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.repay_loan(
  p_user_id uuid, p_loan_id uuid, p_amount_micro bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_loan public.loans%rowtype; v_secs numeric; v_new_int bigint; v_owed bigint; v_pay bigint;
  v_to_interest bigint; v_to_principal bigint; v_bal bigint; v_closed boolean := false;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN RAISE EXCEPTION 'forbidden'; END IF;
  SELECT * INTO v_loan FROM public.loans WHERE id=p_loan_id AND user_id=p_user_id AND status='active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'No active loan found'; END IF;
  IF p_amount_micro IS NULL OR p_amount_micro <= 0 THEN RAISE EXCEPTION 'Amount must be positive'; END IF;

  v_secs    := EXTRACT(EPOCH FROM (now() - v_loan.last_accrued_at));
  v_new_int := FLOOR(v_loan.principal_micro * v_loan.apr_percent / 100.0 * v_secs / 31557600.0);
  v_loan.accrued_interest_micro := v_loan.accrued_interest_micro + v_new_int;
  UPDATE public.loans SET accrued_interest_micro = v_loan.accrued_interest_micro, last_accrued_at = now() WHERE id=p_loan_id;

  v_owed := v_loan.principal_micro + v_loan.accrued_interest_micro;
  v_pay  := LEAST(p_amount_micro, v_owed);

  SELECT usdc_balance_micro INTO v_bal FROM public.wallets WHERE user_id=p_user_id FOR UPDATE;
  IF COALESCE(v_bal,0) < v_pay THEN RAISE EXCEPTION 'Insufficient balance to repay'; END IF;
  UPDATE public.wallets SET usdc_balance_micro = usdc_balance_micro - v_pay, updated_at=now() WHERE user_id=p_user_id;

  v_to_interest  := LEAST(v_pay, v_loan.accrued_interest_micro);
  v_to_principal := v_pay - v_to_interest;
  UPDATE public.loans SET accrued_interest_micro = accrued_interest_micro - v_to_interest,
                          principal_micro = principal_micro - v_to_principal WHERE id=p_loan_id;

  IF v_to_interest > 0 THEN
    UPDATE public.platform_settings SET value=(COALESCE(value::bigint,0)+FLOOR(v_to_interest/10000))::text WHERE key='platform_revenue_kobo';
  END IF;

  INSERT INTO public.transactions (user_id, type, direction, amount_kobo, amount_usdc_micro, description, status)
  VALUES (p_user_id, 'loan_repayment', 'debit', FLOOR(v_pay/10000), v_pay,
          format('Loan repayment ₦%s (₦%s interest, ₦%s principal)',
                 (v_pay/1e6)::numeric(20,2), (v_to_interest/1e6)::numeric(20,2), (v_to_principal/1e6)::numeric(20,2)), 'completed');

  SELECT * INTO v_loan FROM public.loans WHERE id=p_loan_id;
  IF v_loan.principal_micro <= 0 AND v_loan.accrued_interest_micro <= 0 THEN
    UPDATE public.loans SET status='repaid', closed_at=now() WHERE id=p_loan_id;
    UPDATE public.savings_locks      SET pledged_loan_id=NULL WHERE pledged_loan_id=p_loan_id;
    UPDATE public.portfolio_holdings SET pledged_loan_id=NULL WHERE pledged_loan_id=p_loan_id;
    v_closed := true;
  END IF;

  RETURN jsonb_build_object('paid_micro', v_pay,
    'remaining_principal_micro', GREATEST(0, v_loan.principal_micro),
    'remaining_interest_micro',  GREATEST(0, v_loan.accrued_interest_micro), 'closed', v_closed);
END;
$$;

-- ── accrue_loan_interest (cron) ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.accrue_loan_interest()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_loan public.loans%rowtype; v_secs numeric; v_int bigint; v_n int := 0;
BEGIN
  FOR v_loan IN SELECT * FROM public.loans WHERE status='active' LOOP
    v_secs := EXTRACT(EPOCH FROM (now() - v_loan.last_accrued_at));
    v_int  := FLOOR(v_loan.principal_micro * v_loan.apr_percent / 100.0 * v_secs / 31557600.0);
    IF v_int > 0 THEN
      UPDATE public.loans SET accrued_interest_micro = accrued_interest_micro + v_int, last_accrued_at = now() WHERE id = v_loan.id;
      v_n := v_n + 1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('accrued', v_n);
END;
$$;

-- ── liquidate_overdue_loans (cron) ───────────────────────────────────────────
-- Seizes BOTH collateral types. Equity is seized at its cached cNGN value (the
-- physical broker sale is an operational settlement); fixed savings are seized in
-- full. Undercollateralisation only triggers on a fresh equity price (via the value
-- the loan_collateral was pledged at / current cache); overdue triggers regardless.
CREATE OR REPLACE FUNCTION public.liquidate_overdue_loans()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_loan public.loans%rowtype;
  v_grace numeric := public._loan_setting('loan_liquidation_grace_days', 7);
  v_thresh numeric := public._loan_setting('loan_liquidation_threshold', 85);
  v_max_age int := public._loan_setting('loan_equity_price_max_age_min', 360)::int;
  v_secs numeric; v_int bigint; v_owed bigint; v_collateral bigint; v_seized bigint; v_surplus bigint;
  v_overdue boolean; r record; v_n int := 0;
BEGIN
  FOR v_loan IN SELECT * FROM public.loans WHERE status='active' FOR UPDATE LOOP
    v_secs := EXTRACT(EPOCH FROM (now() - v_loan.last_accrued_at));
    v_int  := FLOOR(v_loan.principal_micro * v_loan.apr_percent / 100.0 * v_secs / 31557600.0);
    UPDATE public.loans SET accrued_interest_micro = accrued_interest_micro + v_int, last_accrued_at = now() WHERE id = v_loan.id;
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
      FOR r IN SELECT h.id, h.shares, COALESCE(p.price_ngn_micro,0) AS px
               FROM public.portfolio_holdings h LEFT JOIN public.equity_prices p ON p.symbol=h.symbol
               WHERE h.pledged_loan_id=v_loan.id AND h.shares > 0 LOOP
        v_seized := v_seized + FLOOR(r.shares * r.px);
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

-- ── withdraw_lock: block early withdrawal of a PLEDGED lock ───────────────────
-- 014 version, unchanged except for the pledge guard.
CREATE OR REPLACE FUNCTION public.withdraw_lock(
  p_user_id uuid, p_lock_id uuid, p_early boolean DEFAULT false
) RETURNS boolean AS $$
DECLARE
  v_lock public.savings_locks%rowtype; v_payout bigint; v_penalty_kobo bigint := 0;
  v_penalty_micro bigint := 0;
  v_spread_micro bigint := 0; v_xauto_rate numeric := 56.0; v_user_rate numeric := 50.0;
BEGIN
  SELECT * INTO v_lock FROM public.savings_locks
  WHERE id = p_lock_id AND user_id = p_user_id AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  -- Pledged as loan collateral → not withdrawable until the loan is cleared.
  IF v_lock.pledged_loan_id IS NOT NULL THEN RETURN false; END IF;

  IF p_early AND now() < v_lock.unlocks_at THEN
    -- Breaking fee is CHARGED (deducted from principal), not merely recorded. The
    -- earlier version booked the fee as revenue but returned FULL principal — phantom
    -- revenue with no cash behind it. Interest is forfeited (principal only).
    v_penalty_micro := floor(v_lock.amount_usdc_micro * 0.005);
    v_payout := v_lock.amount_usdc_micro - v_penalty_micro;
    v_penalty_kobo := floor(v_lock.amount_kobo * 0.005);
    UPDATE public.savings_locks SET status = 'early_withdrawn', withdrawn_at = now() WHERE id = p_lock_id;
    IF v_penalty_kobo > 0 THEN
      INSERT INTO public.platform_fees (user_id, transaction_ref, fee_type, gross_amount_kobo, fee_amount_kobo, fee_percent)
      VALUES (p_user_id, p_lock_id::text, 'vault_lock_penalty', v_lock.amount_kobo, v_penalty_kobo, 0.50);
      UPDATE public.platform_settings SET value = (COALESCE(value::bigint, 0) + v_penalty_kobo)::text WHERE key = 'platform_revenue_kobo';
    END IF;
  ELSE
    v_payout := v_lock.amount_usdc_micro + v_lock.projected_interest_micro;
    SELECT COALESCE(value::numeric, 56.0) INTO v_xauto_rate FROM public.platform_settings WHERE key = 'xauto_product_apy_percent';
    SELECT COALESCE(value::numeric, 50.0) INTO v_user_rate  FROM public.platform_settings WHERE key = 'xauto_user_apy_percent';
    v_spread_micro := FLOOR(v_lock.amount_usdc_micro::numeric * ((v_xauto_rate - v_user_rate) / 100.0) * (v_lock.duration_days::numeric / 365.0));
    UPDATE public.savings_locks SET status = 'withdrawn', matured_at = now(), withdrawn_at = now() WHERE id = p_lock_id;
    IF v_spread_micro > 0 THEN
      INSERT INTO public.platform_fees (user_id, transaction_ref, fee_type, gross_amount_kobo, fee_amount_kobo, fee_percent)
      VALUES (p_user_id, p_lock_id::text, 'xauto_spread', v_lock.amount_kobo,
              floor(v_lock.amount_kobo::numeric * ((v_xauto_rate - v_user_rate) / 100.0) * (v_lock.duration_days::numeric / 365.0)), (v_xauto_rate - v_user_rate));
    END IF;
  END IF;

  UPDATE public.wallets SET cngn_pool_micro = cngn_pool_micro + v_payout, updated_at = now() WHERE user_id = p_user_id;
  INSERT INTO public.transactions (user_id, type, direction, amount_kobo, amount_usdc_micro, description, status)
  VALUES (p_user_id, 'vault_withdraw', 'credit', v_lock.amount_kobo, v_payout,
    CASE WHEN p_early THEN 'Early lock withdrawal (principal only)'
         ELSE 'Matured lock withdrawn + ' || v_lock.projected_interest_micro || ' uUSDC interest (X Auto 50% APY)' END, 'completed');
  RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── Grants ───────────────────────────────────────────────────────────────────
GRANT EXECUTE ON FUNCTION public._loan_equity_value(uuid)            TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.loan_borrow_limit(uuid)             TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_loan(uuid, bigint, int, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.repay_loan(uuid, uuid, bigint)      TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.accrue_loan_interest()             TO service_role;
GRANT EXECUTE ON FUNCTION public.liquidate_overdue_loans()          TO service_role;
GRANT EXECUTE ON FUNCTION public.withdraw_lock(uuid, uuid, boolean) TO service_role;