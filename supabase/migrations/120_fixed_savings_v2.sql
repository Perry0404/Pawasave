-- 120_fixed_savings_v2.sql — Fixed Savings v2: no early exit, paid out automatically, asset-backed
--
-- What changes for the saver
--   * A v2 lock cannot be broken. There is no early-withdrawal path, in SQL or the app.
--   * At maturity it pays itself out: principal + the interest quoted at signup lands in the
--     spendable balance without the saver doing anything (cron: /api/cron/fixed-savings-mature).
--   * The rate is fixed when the lock opens and is quoted as a naira amount and a date.
--
-- What backs it
--   Each lock records the asset that backs it (backing_token) and that asset's rate at the
--   time (backing_apy_percent). Today that is GetEquity's gNTB T-bill fund (~14.5%); later the
--   GetEquity credit fund. savings-gntb-sync buys the backing for every active v2 lock and
--   writes the live rate of the configured asset into fixed_v2_backing_apy_percent.
--
--   The rate safety rule: a lock only opens while
--       fixed_v2_user_apy_percent <= fixed_v2_backing_apy_percent - fixed_v2_min_spread_percent
--   so the platform never quotes a rate the backing asset does not earn. While the sync has not
--   run (backing rate 0) nothing opens.
--
--   Policy (2026-10-23): fixed savings stays OFF (fixed_v2_enabled = false) until an asset can
--   back 20–22%. The saver rate defaults to 20%, so even if switched on it cannot open on gNTB
--   (14.5%); it needs an asset earning at least 21.5%, i.e. the GetEquity credit fund.
--
-- Borrowing against it: allowed, but the lock is HELD to maturity, never sold or seized
-- (section 6). The loan is funded from lending buffers and repaid from the payout (section 5).
--
-- Switching the backing asset (e.g. to the credit fund) is two settings:
--   fixed_v2_backing_token and fixed_v2_user_apy_percent. Open locks keep their own backing.
--
-- v1 (lock_savings / fixed_savings_enabled) is untouched and stays off.
-- Safe to re-run.

-- ── 1. Columns ───────────────────────────────────────────────────────────────
ALTER TABLE public.savings_locks
  ADD COLUMN IF NOT EXISTS version             smallint    NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS breakable           boolean     NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS backing_token       text,
  ADD COLUMN IF NOT EXISTS backing_apy_percent numeric,
  ADD COLUMN IF NOT EXISTS paid_out_at         timestamptz,
  ADD COLUMN IF NOT EXISTS payout_reference    text;

-- The maturity job scans for these.
CREATE INDEX IF NOT EXISTS savings_locks_due_idx
  ON public.savings_locks (unlocks_at) WHERE status = 'active' AND paid_out_at IS NULL;

-- ── 2. Settings ──────────────────────────────────────────────────────────────
INSERT INTO public.platform_settings (key, value) VALUES
  ('fixed_v2_enabled',             'false'),
  ('fixed_v2_user_apy_percent',    '20'),             -- stays shut until an asset earns >= 21.5%
  ('fixed_v2_min_spread_percent',  '1.5'),
  ('fixed_v2_terms_days',          '90,180,365'),
  ('fixed_v2_min_amount_micro',    '1000000000'),            -- ₦1,000
  ('fixed_v2_backing_token',       '0x0BBD0A655773AabCF014B7C6E7a2FFB5489528f0'), -- gNTB
  ('fixed_v2_backing_name',        'Nigerian Treasury Bills (gNTB) via GetEquity'),
  ('fixed_v2_backing_apy_percent', '0')                      -- written by savings-gntb-sync
ON CONFLICT (key) DO NOTHING;

-- ── 3. Open a v2 lock ────────────────────────────────────────────────────────
-- Service role only: the app reaches it through /api/savings/fixed, which checks the session,
-- the compliance hold and the transaction PIN first.
CREATE OR REPLACE FUNCTION public.lock_savings_v2(
  p_user_id       uuid,
  p_amount_micro  bigint,
  p_duration_days int,
  p_consent       boolean
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  w           public.wallets%rowtype;
  v_enabled   text    := COALESCE((SELECT value FROM public.platform_settings WHERE key = 'fixed_v2_enabled'), 'false');
  v_user      numeric := COALESCE((SELECT value::numeric FROM public.platform_settings WHERE key = 'fixed_v2_user_apy_percent'), 0);
  v_backing   numeric := COALESCE((SELECT value::numeric FROM public.platform_settings WHERE key = 'fixed_v2_backing_apy_percent'), 0);
  v_spread    numeric := COALESCE((SELECT value::numeric FROM public.platform_settings WHERE key = 'fixed_v2_min_spread_percent'), 1.5);
  v_terms     text    := COALESCE((SELECT value FROM public.platform_settings WHERE key = 'fixed_v2_terms_days'), '');
  v_min       bigint  := COALESCE((SELECT value::bigint FROM public.platform_settings WHERE key = 'fixed_v2_min_amount_micro'), 1000000000);
  v_token     text    := (SELECT value FROM public.platform_settings WHERE key = 'fixed_v2_backing_token');
  v_projected bigint;
  v_kobo      bigint;
  v_id        uuid;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'lock_savings_v2: unauthorized';
  END IF;
  IF v_enabled <> 'true' THEN
    RAISE EXCEPTION 'Fixed savings is coming soon';
  END IF;
  IF p_consent IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Please confirm you understand this savings cannot be withdrawn before it matures';
  END IF;
  IF p_duration_days IS NULL OR NOT (p_duration_days::text = ANY (string_to_array(replace(v_terms, ' ', ''), ','))) THEN
    RAISE EXCEPTION '% days is not an offered term', p_duration_days;
  END IF;
  IF p_amount_micro IS NULL OR p_amount_micro < v_min THEN
    RAISE EXCEPTION 'Minimum fixed savings is ₦%', (v_min / 1000000);
  END IF;
  IF v_token IS NULL OR v_token = '' OR v_user <= 0 OR v_user > v_backing - v_spread THEN
    RAISE EXCEPTION 'Fixed savings is not open right now. Please try again later.';
  END IF;

  SELECT * INTO w FROM public.wallets WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'lock_savings_v2: no wallet'; END IF;
  IF w.cngn_pool_micro < p_amount_micro THEN
    RAISE EXCEPTION 'Insufficient savings balance';
  END IF;

  v_projected := floor(p_amount_micro::numeric * v_user / 100.0 * p_duration_days / 365.0);
  v_kobo      := floor(p_amount_micro / 10000);

  UPDATE public.wallets
  SET cngn_pool_micro = cngn_pool_micro - p_amount_micro, updated_at = now()
  WHERE user_id = p_user_id;

  INSERT INTO public.savings_locks (
    user_id, amount_usdc_micro, amount_kobo, apy_percent, duration_days,
    projected_interest_micro, effective_rate_at_creation, unlocks_at,
    user_consent_accepted, consent_accepted_at,
    version, breakable, backing_token, backing_apy_percent
  ) VALUES (
    p_user_id, p_amount_micro, v_kobo, v_user, p_duration_days,
    v_projected, round(v_user * p_duration_days / 365.0, 4), now() + make_interval(days => p_duration_days),
    true, now(),
    2, false, v_token, v_backing
  ) RETURNING id INTO v_id;

  INSERT INTO public.transactions (user_id, type, direction, amount_kobo, amount_usdc_micro, description, reference, status)
  VALUES (p_user_id, 'save_to_vault', 'debit', v_kobo, p_amount_micro,
          'Fixed savings for ' || p_duration_days || ' days at ' || v_user || '% a year',
          'lock-open-' || v_id, 'completed');

  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.lock_savings_v2(uuid, bigint, int, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lock_savings_v2(uuid, bigint, int, boolean) TO service_role;

-- ── 4. withdraw_lock: a v2 lock has no early exit ────────────────────────────
-- 099's body with one guard added after the pledge check. withdraw_lock is still granted to
-- authenticated, so the guard has to live here, not only in the API route.
CREATE OR REPLACE FUNCTION public.withdraw_lock(
  p_user_id uuid, p_lock_id uuid, p_early boolean DEFAULT false
) RETURNS boolean AS $$
DECLARE
  v_lock public.savings_locks%rowtype; v_payout bigint; v_penalty_kobo bigint := 0;
  v_penalty_micro bigint := 0;
  v_spread_micro bigint := 0; v_xauto_rate numeric := 56.0; v_user_rate numeric := 50.0;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'withdraw_lock: unauthorized';
  END IF;

  SELECT * INTO v_lock FROM public.savings_locks
  WHERE id = p_lock_id AND user_id = p_user_id AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  IF v_lock.pledged_loan_id IS NOT NULL THEN RETURN false; END IF;

  -- v2: never early, and never through this function at all. The maturity job pays it out.
  IF NOT v_lock.breakable THEN
    RAISE EXCEPTION 'This fixed savings is locked until % and pays out automatically on that day',
      to_char(v_lock.unlocks_at AT TIME ZONE 'Africa/Lagos', 'DD Mon YYYY');
  END IF;

  IF NOT p_early AND now() < v_lock.unlocks_at THEN
    RAISE EXCEPTION 'withdraw_lock: this lock matures on % — pass p_early to break it', v_lock.unlocks_at;
  END IF;

  IF p_early AND now() < v_lock.unlocks_at THEN
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
         ELSE 'Matured lock withdrawn with ' || v_lock.projected_interest_micro || ' micro interest' END, 'completed');
  RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
GRANT EXECUTE ON FUNCTION public.withdraw_lock(uuid,uuid,boolean) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.withdraw_lock(uuid,uuid,boolean) FROM PUBLIC, anon;

-- ── 5. Automatic payout at maturity ──────────────────────────────────────────
-- Service role only; run every 45 minutes. Idempotent three ways: the row lock (SKIP LOCKED, so two
-- runs never take the same lock), paid_out_at, and the unique transactions.reference.
-- Pays into the spendable balance so the money is the saver's to use the moment it lands.
-- The spread (backing rate − saver rate over the term) is booked as revenue at payout.
--
-- Borrowed against: a v2 lock can back a loan, but it is HELD, never sold early (section 6).
-- At maturity the payout settles that loan first (interest, then principal, booked exactly as
-- repay_loan books it) and the rest goes to the saver. If the loan is cleared, all of its
-- other collateral is released too.
CREATE OR REPLACE FUNCTION public.mature_fixed_locks(p_limit int DEFAULT 200)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  r            record;
  v_loan       public.loans%rowtype;
  v_payout     bigint;
  v_to_user    bigint;
  v_spread     bigint;
  v_new_int    bigint;
  v_int_due    bigint;
  v_owed       bigint;
  v_pay        bigint;
  v_to_int     bigint;
  v_to_prin    bigint;
  v_repaid     bigint;
  v_paid       jsonb  := '[]'::jsonb;
  v_total      bigint := 0;
  v_spread_tot bigint := 0;
BEGIN
  FOR r IN
    SELECT * FROM public.savings_locks
    WHERE version = 2 AND status = 'active' AND paid_out_at IS NULL AND unlocks_at <= now()
    ORDER BY unlocks_at
    LIMIT GREATEST(1, LEAST(p_limit, 1000))
    FOR UPDATE SKIP LOCKED
  LOOP
    PERFORM 1 FROM public.wallets WHERE user_id = r.user_id FOR UPDATE;
    IF NOT FOUND THEN CONTINUE; END IF;

    v_payout  := r.amount_usdc_micro + COALESCE(r.projected_interest_micro, 0);
    v_to_user := v_payout;
    v_repaid  := 0;

    INSERT INTO public.transactions (user_id, type, direction, amount_kobo, amount_usdc_micro, description, reference, status)
    VALUES (r.user_id, 'vault_withdraw', 'credit', floor(v_payout / 10000), v_payout,
            'Fixed savings matured: principal + ' || r.apy_percent || '% interest',
            'lock-payout-' || r.id, 'completed');

    -- ── settle a loan this lock was backing ──
    IF r.pledged_loan_id IS NOT NULL THEN
      SELECT * INTO v_loan FROM public.loans WHERE id = r.pledged_loan_id AND status = 'active' FOR UPDATE;
      IF FOUND THEN
        v_new_int := floor(v_loan.principal_micro * v_loan.apr_percent / 100.0
                           * EXTRACT(EPOCH FROM (now() - v_loan.last_accrued_at)) / 31557600.0);
        v_int_due := v_loan.accrued_interest_micro + v_new_int;
        v_owed    := v_loan.principal_micro + v_int_due;
        v_pay     := LEAST(v_payout, v_owed);
        v_to_int  := LEAST(v_pay, v_int_due);
        v_to_prin := v_pay - v_to_int;

        UPDATE public.loans
        SET accrued_interest_micro = v_int_due - v_to_int,
            principal_micro        = principal_micro - v_to_prin,
            last_accrued_at        = now()
        WHERE id = v_loan.id;

        IF v_to_int > 0 THEN
          UPDATE public.platform_settings SET value = (COALESCE(value::bigint, 0) + floor(v_to_int / 10000))::text
          WHERE key = 'platform_revenue_kobo';
          INSERT INTO public.platform_fees (user_id, transaction_ref, fee_type, gross_amount_kobo, fee_amount_kobo, fee_percent)
          VALUES (r.user_id, v_loan.id::text, 'loan_interest', floor(v_pay / 10000), floor(v_to_int / 10000), v_loan.apr_percent);
        END IF;

        IF v_pay > 0 THEN
          INSERT INTO public.transactions (user_id, type, direction, amount_kobo, amount_usdc_micro, description, reference, status)
          VALUES (r.user_id, 'loan_repayment', 'debit', floor(v_pay / 10000), v_pay,
                  format('Loan repaid from matured fixed savings ₦%s (₦%s interest, ₦%s principal)',
                         (v_pay / 1e6)::numeric(20,2), (v_to_int / 1e6)::numeric(20,2), (v_to_prin / 1e6)::numeric(20,2)),
                  'lock-loan-' || r.id, 'completed');
        END IF;

        IF v_owed - v_pay <= 10000 THEN
          UPDATE public.loans SET status = 'repaid', closed_at = now(), principal_micro = 0, accrued_interest_micro = 0
          WHERE id = v_loan.id;
          UPDATE public.savings_locks      SET pledged_loan_id = NULL WHERE pledged_loan_id = v_loan.id;
          UPDATE public.portfolio_holdings SET pledged_loan_id = NULL WHERE pledged_loan_id = v_loan.id;
        END IF;

        v_repaid  := v_pay;
        v_to_user := v_payout - v_pay;
      END IF;
    END IF;

    UPDATE public.wallets SET usdc_balance_micro = usdc_balance_micro + v_to_user, updated_at = now()
    WHERE user_id = r.user_id;

    UPDATE public.savings_locks
    SET status = 'withdrawn', matured_at = now(), withdrawn_at = now(), pledged_loan_id = NULL,
        paid_out_at = now(), payout_reference = 'lock-payout-' || r.id
    WHERE id = r.id;

    v_spread := floor(r.amount_usdc_micro::numeric
                      * GREATEST(COALESCE(r.backing_apy_percent, 0) - COALESCE(r.apy_percent, 0), 0) / 100.0
                      * r.duration_days / 365.0);
    IF v_spread > 0 THEN
      INSERT INTO public.revenue_journal (user_id, revenue_type, amount_usdc_micro, description)
      VALUES (r.user_id, 'yield_spread', v_spread,
              format('Fixed savings spread: backing %s%% - saver %s%% over %s days', r.backing_apy_percent, r.apy_percent, r.duration_days));
      v_spread_tot := v_spread_tot + v_spread;
    END IF;

    v_total := v_total + v_payout;
    v_paid  := v_paid || jsonb_build_object('lock_id', r.id, 'user_id', r.user_id,
                                            'principal_micro', r.amount_usdc_micro, 'payout_micro', v_payout,
                                            'loan_repaid_micro', v_repaid, 'to_balance_micro', v_to_user);
  END LOOP;

  IF v_spread_tot > 0 THEN
    UPDATE public.platform_settings
    SET value = (COALESCE(value::bigint, 0) + floor(v_spread_tot / 10000))::text
    WHERE key = 'platform_revenue_kobo';
  END IF;

  RETURN jsonb_build_object('paid', v_paid, 'total_micro', v_total, 'spread_micro', v_spread_tot);
END;
$$;
REVOKE ALL ON FUNCTION public.mature_fixed_locks(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mature_fixed_locks(int) TO service_role;

-- ── 6. Loans against fixed savings: hold, never sell ─────────────────────────
-- A v2 lock can still be borrowed against (create_loan and loan_borrow_limit are unchanged).
-- What changes is the bad case. 114's liquidation seized pledged locks in full, which for a v2
-- lock would break it early. Now:
--   * v2 locks are never seized. Their value at maturity (principal + quoted interest) is
--     "held" collateral.
--   * If the held value covers the whole debt, the loan is left to run. Interest keeps accruing
--     and mature_fixed_locks repays it from the payout. Nothing is sold.
--   * If it does not, the other collateral (v1 locks, stocks) is seized as before, but the
--     proceeds pay down the debt instead of closing the loan. The held lock settles the rest
--     at maturity.
--   * Loans with no v2 lock behave exactly as in 114.
-- The cash to fund a loan while its lock is held comes from the lending buffers, not from
-- selling the lock's backing.
CREATE OR REPLACE FUNCTION public.liquidate_overdue_loans()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_loan public.loans%rowtype;
  v_grace numeric := public._loan_setting('loan_liquidation_grace_days', 7);
  v_thresh numeric := public._loan_setting('loan_liquidation_threshold', 85);
  v_max_age int := public._loan_setting('loan_equity_price_max_age_min', 360)::int;
  v_secs numeric; v_int bigint; v_owed bigint; v_collateral bigint; v_seized bigint; v_surplus bigint;
  v_overdue boolean; r record; v_n int := 0; v_val bigint;
  v_held bigint; v_pay bigint; v_to_int bigint; v_to_prin bigint; v_held_n int := 0;
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

    -- 120: what pledged v2 locks will pay at maturity. Held, never seized.
    SELECT COALESCE(SUM(amount_usdc_micro + COALESCE(projected_interest_micro,0)),0) INTO v_held
    FROM public.savings_locks WHERE pledged_loan_id = v_loan.id AND status='active' AND NOT breakable;

    v_overdue := now() > v_loan.due_date + make_interval(days => v_grace::int);

    IF v_overdue OR (v_collateral > 0 AND v_owed * 100 >= v_collateral * v_thresh) THEN
      -- Fully covered by held fixed savings: leave it, the payout repays it at maturity.
      IF v_held > 0 AND v_held >= v_owed THEN
        v_held_n := v_held_n + 1;
        CONTINUE;
      END IF;

      v_seized := 0;
      -- Seize breakable (v1) fixed-savings locks in full. v2 locks are held.
      FOR r IN SELECT id, amount_usdc_micro FROM public.savings_locks
               WHERE pledged_loan_id=v_loan.id AND status='active' AND breakable LOOP
        UPDATE public.savings_locks SET status='liquidated', withdrawn_at=now(), pledged_loan_id=NULL WHERE id=r.id;
        v_seized := v_seized + r.amount_usdc_micro;
      END LOOP;
      -- Seize equity holdings at cached value (0 out the shares; broker sale is operational).
      FOR r IN SELECT h.id, h.shares, h.invested_cngn_micro, COALESCE(p.price_ngn_micro,0) AS px
               FROM public.portfolio_holdings h LEFT JOIN public.equity_prices p ON p.symbol=h.symbol
               WHERE h.pledged_loan_id=v_loan.id AND h.shares > 0 LOOP
        -- 114: no cached price means value it at what the borrower paid, not at nothing.
        IF r.px > 0 THEN
          v_val := FLOOR(r.shares * r.px);
        ELSE
          v_val := r.invested_cngn_micro;
        END IF;
        v_seized := v_seized + v_val;
        UPDATE public.portfolio_holdings SET shares=0, invested_cngn_micro=0, pledged_loan_id=NULL, updated_at=now() WHERE id=r.id;
      END LOOP;

      IF v_held > 0 THEN
        -- Partial: seized collateral pays down the debt (interest first); the held lock settles
        -- the rest at maturity. The loan stays open.
        v_pay     := LEAST(v_seized, v_owed);
        v_to_int  := LEAST(v_pay, v_loan.accrued_interest_micro + v_int);
        v_to_prin := v_pay - v_to_int;
        UPDATE public.loans SET accrued_interest_micro = accrued_interest_micro - v_to_int,
                                principal_micro = principal_micro - v_to_prin WHERE id = v_loan.id;
        IF v_to_int > 0 THEN
          UPDATE public.platform_settings SET value=(COALESCE(value::bigint,0)+FLOOR(v_to_int/10000))::text WHERE key='platform_revenue_kobo';
        END IF;
        v_surplus := GREATEST(0, v_seized - v_pay);
        IF v_surplus > 0 THEN
          UPDATE public.wallets SET usdc_balance_micro = usdc_balance_micro + v_surplus, updated_at=now() WHERE user_id=v_loan.user_id;
        END IF;
        IF v_pay > 0 THEN
          INSERT INTO public.transactions (user_id, type, direction, amount_kobo, amount_usdc_micro, description, status)
          VALUES (v_loan.user_id, 'loan_liquidation', 'debit', FLOOR(v_pay/10000), v_pay,
                  format('Loan partly cleared from collateral ₦%s; the rest is repaid from your fixed savings when it matures',
                         (v_pay/1e6)::numeric(20,2)), 'completed');
          v_n := v_n + 1;
        END IF;
        CONTINUE;
      END IF;

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
  RETURN jsonb_build_object('liquidated', v_n, 'held_to_maturity', v_held_n);
END;
$$;
GRANT EXECUTE ON FUNCTION public.liquidate_overdue_loans() TO service_role;
REVOKE ALL ON FUNCTION public.liquidate_overdue_loans() FROM PUBLIC, anon, authenticated;

-- ── 7. Expose the v2 settings to the app (read-only) ─────────────────────────
CREATE OR REPLACE FUNCTION public.get_apy_settings()
RETURNS jsonb AS $$
DECLARE result jsonb;
BEGIN
  SELECT jsonb_object_agg(key, value) INTO result
  FROM public.platform_settings
  WHERE key IN (
    'flexible_apy_percent',
    'xauto_user_apy_percent',
    'mm_user_apy_percent',
    'cngn_pool_apy_percent',
    'ajo_user_apy_percent',
    'goals_user_apy_percent',
    'fixed_user_apy_percent',
    'fixed_savings_enabled',
    'yield_backing_apy_percent',
    'fixed_v2_enabled',
    'fixed_v2_user_apy_percent',
    'fixed_v2_min_spread_percent',
    'fixed_v2_terms_days',
    'fixed_v2_min_amount_micro',
    'fixed_v2_backing_name',
    'fixed_v2_backing_apy_percent'
  );
  RETURN COALESCE(result, '{}'::jsonb);
END;
$$ LANGUAGE plpgsql STABLE;
GRANT EXECUTE ON FUNCTION public.get_apy_settings() TO anon, authenticated, service_role;
