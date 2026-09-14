-- 056_getequity_investments.sql
-- GetEquity regulated-RWA marketplace: users buy tokenized Nigerian investment
-- products (Treasury bills, mutual funds, REITs, IPOs) with cNGN. Positions are
-- held on-chain in PawaSave custody (pooled) and mirrored to the user's ledger,
-- exactly like the equity portfolio (032) — same debit→settle→refund safety.
--
-- Money safety: place_getequity_order debits cNGN AND writes a 'pending' order in
-- one transaction; settlement fills it (records on-chain units + tx hash) or fails
-- it (refunds the cNGN). The API only calls this when GETEQUITY_ENABLED is set.
-- KYC ('verified') required. Idempotent: safe to run more than once.
--
-- NOTE: GetEquity is on Base Sepolia testnet; this ships DARK. Nothing writes here
-- until the integration is switched on (see docs/getequity-integration.md).

-- Reuse portfolio_holdings (032) for the position ledger — widen its asset_type
-- check to admit regulated RWAs. Provider 'getequity' keeps them from colliding
-- with equity rows under the UNIQUE (user_id, symbol, provider) key.
ALTER TABLE public.portfolio_holdings
  DROP CONSTRAINT IF EXISTS portfolio_holdings_asset_type_check;
ALTER TABLE public.portfolio_holdings
  ADD  CONSTRAINT portfolio_holdings_asset_type_check
       CHECK (asset_type IN ('tokenized_stock', 'pre_ipo', 'rwa'));

-- Admit 'investment' on transactions so a filled buy books a ledger row — it then
-- shows in the user's activity feed AND is counted by admin_tx_volume (057).
-- Superset of 046's list.
ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
ALTER TABLE public.transactions ADD CONSTRAINT transactions_type_check CHECK (type IN (
  'deposit', 'withdrawal', 'save_to_vault', 'vault_withdraw',
  'esusu_contribute', 'esusu_payout', 'emergency_payout',
  'split_auto_save', 'split_auto_esusu',
  'goal_contribute', 'goal_claim',
  'creator_incentive', 'cngn_pool_in',
  'loan_disbursement', 'loan_repayment', 'loan_liquidation',
  'investment'
));

CREATE TABLE IF NOT EXISTS public.getequity_orders (
  id                BIGSERIAL PRIMARY KEY,
  user_id           UUID NOT NULL,
  symbol            TEXT NOT NULL,                          -- e.g. 'NTBL', 'ARMNGF'
  token             TEXT NOT NULL,                          -- RWA ERC-20 address (Base)
  side              TEXT NOT NULL DEFAULT 'buy'
                    CHECK (side IN ('buy', 'sell')),
  amount_cngn_micro BIGINT NOT NULL CHECK (amount_cngn_micro > 0), -- NET spent on-chain (budget)
  fee_cngn_micro    BIGINT NOT NULL DEFAULT 0,               -- PawaSave platform fee (revenue on fill)
  units             NUMERIC,                                -- filled token qty (whole units)
  tx_hash           TEXT,                                   -- on-chain settlement hash
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'filled', 'failed', 'refunded')),
  error             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_getequity_orders_user ON public.getequity_orders (user_id, created_at DESC);

-- Idempotent: add the fee column if this table pre-dates the fee (re-run safe).
ALTER TABLE public.getequity_orders ADD COLUMN IF NOT EXISTS fee_cngn_micro BIGINT NOT NULL DEFAULT 0;

-- Admit the GetEquity investment fee as a revenue type (keeps the full latest list
-- from 052 + 'investment_fee'). PawaSave charges this on top of GetEquity's own
-- on-chain vault fee; only OUR fee is booked to platform revenue.
ALTER TABLE public.platform_fees DROP CONSTRAINT IF EXISTS platform_fees_fee_type_check;
ALTER TABLE public.platform_fees ADD CONSTRAINT platform_fees_fee_type_check CHECK (fee_type IN (
  'ramp_onramp', 'ramp_offramp', 'vault_lock_penalty', 'admin_revenue_withdrawal',
  'esusu_penalty', 'xauto_spread', 'goal_break_penalty', 'loan_origination', 'loan_interest',
  'investment_fee'
));

ALTER TABLE public.getequity_orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ge_orders_owner_read ON public.getequity_orders;
CREATE POLICY ge_orders_owner_read ON public.getequity_orders FOR SELECT USING (auth.uid() = user_id);

-- ── place_getequity_order: atomic cNGN debit (net + fee) + pending buy order ──
-- cNGN is stored in wallets.usdc_balance_micro (6 dp), same as the rest of the app.
-- p_amount_cngn_micro = NET spent on-chain; p_fee_cngn_micro = PawaSave fee. The
-- wallet is debited the sum; the fee is only booked to revenue when the buy fills
-- (settle 'filled'), and fully refunded with the net if the buy fails.
-- Identity: matches the LIVE tokenized-stock policy (see /api/invest/equity) —
-- Strails BVN onboarding is sufficient to invest; full 'verified' also passes.
DROP FUNCTION IF EXISTS public.place_getequity_order(UUID, TEXT, TEXT, BIGINT);
CREATE OR REPLACE FUNCTION public.place_getequity_order(
  p_user_id           UUID,
  p_symbol            TEXT,
  p_token             TEXT,
  p_amount_cngn_micro BIGINT,
  p_fee_cngn_micro    BIGINT DEFAULT 0
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  w       public.wallets%rowtype;
  p       public.profiles%rowtype;
  v_total BIGINT;
  v_order BIGINT;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() != p_user_id THEN
    RAISE EXCEPTION 'place_getequity_order: unauthorized';
  END IF;
  IF p_amount_cngn_micro IS NULL OR p_amount_cngn_micro <= 0 THEN
    RAISE EXCEPTION 'place_getequity_order: amount must be positive';
  END IF;
  IF p_token IS NULL OR length(p_token) = 0 THEN
    RAISE EXCEPTION 'place_getequity_order: token required';
  END IF;

  SELECT * INTO p FROM public.profiles WHERE id = p_user_id;
  IF NOT (p.kyc_status = 'verified'
          OR p.strails_onboard_status = 'completed'
          OR COALESCE(p.strails_va_account_number, '') <> '') THEN
    RAISE EXCEPTION 'place_getequity_order: identity not verified';
  END IF;

  v_total := p_amount_cngn_micro + GREATEST(0, COALESCE(p_fee_cngn_micro, 0));

  SELECT * INTO w FROM public.wallets WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND OR w.usdc_balance_micro < v_total THEN
    RAISE EXCEPTION 'place_getequity_order: insufficient cNGN balance';
  END IF;

  UPDATE public.wallets
  SET usdc_balance_micro = usdc_balance_micro - v_total, updated_at = now()
  WHERE user_id = p_user_id;

  INSERT INTO public.getequity_orders (user_id, symbol, token, side, amount_cngn_micro, fee_cngn_micro)
  VALUES (p_user_id, upper(p_symbol), p_token, 'buy', p_amount_cngn_micro, GREATEST(0, COALESCE(p_fee_cngn_micro, 0)))
  RETURNING id INTO v_order;

  RETURN v_order;
END;
$$;

-- ── settle_getequity_order: fill (record units) or fail (refund cNGN) ─────────
CREATE OR REPLACE FUNCTION public.settle_getequity_order(
  p_order_id BIGINT,
  p_status   TEXT,             -- 'filled' | 'failed'
  p_units    NUMERIC DEFAULT NULL,
  p_tx_hash  TEXT DEFAULT NULL,
  p_error    TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE o public.getequity_orders%rowtype;
BEGIN
  SELECT * INTO o FROM public.getequity_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND OR o.status <> 'pending' THEN
    RETURN; -- idempotent: ignore double-settlement
  END IF;

  IF p_status = 'filled' THEN
    UPDATE public.getequity_orders
    SET status = 'filled', units = p_units, tx_hash = p_tx_hash, updated_at = now()
    WHERE id = p_order_id;

    INSERT INTO public.portfolio_holdings (user_id, symbol, asset_type, provider, invested_cngn_micro, shares)
    VALUES (o.user_id, o.symbol, 'rwa', 'getequity', o.amount_cngn_micro, COALESCE(p_units, 0))
    ON CONFLICT (user_id, symbol, provider) DO UPDATE
      SET invested_cngn_micro = public.portfolio_holdings.invested_cngn_micro + o.amount_cngn_micro,
          shares              = public.portfolio_holdings.shares + COALESCE(p_units, 0),
          updated_at          = now();

    -- Ledger row: appears in the user's activity feed and feeds admin_tx_volume.
    -- amount_kobo = naira*100 = cngn_micro/10000; amount_usdc_micro = cngn_micro.
    -- Booked against the TOTAL the user paid (net + fee) so activity matches the debit.
    INSERT INTO public.transactions
      (user_id, type, direction, amount_kobo, amount_usdc_micro, description, reference, status, metadata)
    VALUES
      (o.user_id, 'investment', 'debit', FLOOR((o.amount_cngn_micro + o.fee_cngn_micro) / 10000), o.amount_cngn_micro + o.fee_cngn_micro,
       'Invested in ' || o.symbol, 'getequity_' || o.id::text, 'completed',
       jsonb_build_object('channel', 'GetEquity', 'symbol', o.symbol, 'token', o.token, 'units', p_units, 'tx_hash', p_tx_hash,
                          'fee_cngn_micro', o.fee_cngn_micro, 'net_invested_micro', o.amount_cngn_micro));

    -- Book PawaSave's fee to revenue — ONLY on a successful fill (never on refund).
    IF o.fee_cngn_micro > 0 THEN
      INSERT INTO public.platform_fees (user_id, transaction_ref, fee_type, gross_amount_kobo, fee_amount_kobo, fee_percent)
      VALUES (o.user_id, 'getequity_' || o.id::text, 'investment_fee',
              FLOOR((o.amount_cngn_micro + o.fee_cngn_micro) / 10000),
              FLOOR(o.fee_cngn_micro / 10000),
              ROUND((o.fee_cngn_micro::numeric / NULLIF(o.amount_cngn_micro + o.fee_cngn_micro, 0)) * 100, 2));
      UPDATE public.platform_settings
      SET value = (COALESCE(value::bigint, 0) + FLOOR(o.fee_cngn_micro / 10000))::text
      WHERE key = 'platform_revenue_kobo';
    END IF;
  ELSE
    -- Failed buy → refund everything the user paid (net + fee); no revenue booked.
    UPDATE public.wallets
    SET usdc_balance_micro = usdc_balance_micro + o.amount_cngn_micro + o.fee_cngn_micro, updated_at = now()
    WHERE user_id = o.user_id;

    UPDATE public.getequity_orders
    SET status = 'refunded', error = p_error, updated_at = now()
    WHERE id = p_order_id;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.place_getequity_order(UUID, TEXT, TEXT, BIGINT, BIGINT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.settle_getequity_order(BIGINT, TEXT, NUMERIC, TEXT, TEXT) TO service_role;