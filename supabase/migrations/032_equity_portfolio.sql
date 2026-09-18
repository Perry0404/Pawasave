-- 032_equity_portfolio.sql
-- Tokenized-equity portfolio scaffold: tokenized stocks (xStocks) + pre-IPO
-- tokenized shares (e.g. tokenized SpaceX). Both are first-class BUYABLE assets.
--
-- Reality that shapes this (June 2026): xStocks + pre-IPO tokens are issued by
-- Backed Finance and live as SPL tokens on SOLANA (Coinbase/Kraken list them).
-- They are not on Base. So a buy routes: cNGN → USDC(Base) → bridge → USDC(Solana)
-- → swap to the xStock on Jupiter, OR goes through Coinbase's institutional
-- "Coinbase Tokenize" API (custody + USDC rails). Either way it's an off-Base
-- broker step — implemented in `lib/equity-broker.ts`, not here.
--
-- Money safety: place_equity_order debits cNGN AND writes a 'pending' order in
-- one transaction; settlement fills it (records shares) or fails it (refunds the
-- cNGN). The API never calls this unless a broker is actually live.
-- KYC ('verified') is required. Idempotent: safe to run more than once.

CREATE TABLE IF NOT EXISTS public.portfolio_holdings (
  id                  BIGSERIAL PRIMARY KEY,
  user_id             UUID NOT NULL,
  symbol              TEXT NOT NULL,                         -- e.g. 'AAPL', 'SPCX'
  asset_type          TEXT NOT NULL CHECK (asset_type IN ('tokenized_stock', 'pre_ipo')),
  provider            TEXT NOT NULL,                         -- 'coinbase' | 'backed' | 'solana_dex' | ...
  invested_cngn_micro BIGINT NOT NULL DEFAULT 0,             -- cost basis (cNGN, 6 dp)
  shares              NUMERIC NOT NULL DEFAULT 0,            -- filled share qty (fractional)
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, symbol, provider)
);

CREATE TABLE IF NOT EXISTS public.equity_orders (
  id               BIGSERIAL PRIMARY KEY,
  user_id          UUID NOT NULL,
  symbol           TEXT NOT NULL,
  asset_type       TEXT NOT NULL CHECK (asset_type IN ('tokenized_stock', 'pre_ipo')),
  provider         TEXT NOT NULL,
  amount_cngn_micro BIGINT NOT NULL CHECK (amount_cngn_micro > 0),
  usdc_micro       BIGINT,                                  -- after cNGN→USDC swap (on fill)
  shares           NUMERIC,                                 -- filled qty
  broker_ref       TEXT,                                    -- external broker order id
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'filled', 'failed', 'refunded')),
  error            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_equity_orders_user ON public.equity_orders (user_id, created_at DESC);

ALTER TABLE public.portfolio_holdings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.equity_orders      ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS holdings_owner_read ON public.portfolio_holdings;
CREATE POLICY holdings_owner_read ON public.portfolio_holdings FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS orders_owner_read ON public.equity_orders;
CREATE POLICY orders_owner_read ON public.equity_orders FOR SELECT USING (auth.uid() = user_id);

-- ── place_equity_order: atomic cNGN debit + pending order ────────────────────
-- cNGN is stored in usdc_balance_micro. Buyable: tokenized_stock OR pre_ipo.
CREATE OR REPLACE FUNCTION public.place_equity_order(
  p_user_id          UUID,
  p_symbol           TEXT,
  p_asset_type       TEXT,
  p_provider         TEXT,
  p_amount_cngn_micro BIGINT
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  w        public.wallets%rowtype;
  v_kyc    TEXT;
  v_order  BIGINT;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() != p_user_id THEN
    RAISE EXCEPTION 'place_equity_order: unauthorized';
  END IF;
  IF p_amount_cngn_micro IS NULL OR p_amount_cngn_micro <= 0 THEN
    RAISE EXCEPTION 'place_equity_order: amount must be positive';
  END IF;
  IF p_asset_type NOT IN ('tokenized_stock', 'pre_ipo') THEN
    RAISE EXCEPTION 'place_equity_order: unsupported asset type';
  END IF;

  SELECT kyc_status INTO v_kyc FROM public.profiles WHERE id = p_user_id;
  IF v_kyc IS DISTINCT FROM 'verified' THEN
    RAISE EXCEPTION 'place_equity_order: KYC not verified';
  END IF;

  SELECT * INTO w FROM public.wallets WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND OR w.usdc_balance_micro < p_amount_cngn_micro THEN
    RAISE EXCEPTION 'place_equity_order: insufficient cNGN balance';
  END IF;

  UPDATE public.wallets
  SET usdc_balance_micro = usdc_balance_micro - p_amount_cngn_micro, updated_at = now()
  WHERE user_id = p_user_id;

  INSERT INTO public.equity_orders (user_id, symbol, asset_type, provider, amount_cngn_micro)
  VALUES (p_user_id, upper(p_symbol), p_asset_type, p_provider, p_amount_cngn_micro)
  RETURNING id INTO v_order;

  RETURN v_order;
END;
$$;

-- ── settle_equity_order: fill (record shares) or fail (refund cNGN) ───────────
CREATE OR REPLACE FUNCTION public.settle_equity_order(
  p_order_id   BIGINT,
  p_status     TEXT,            -- 'filled' | 'failed'
  p_usdc_micro BIGINT DEFAULT NULL,
  p_shares     NUMERIC DEFAULT NULL,
  p_broker_ref TEXT DEFAULT NULL,
  p_error      TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE o public.equity_orders%rowtype;
BEGIN
  SELECT * INTO o FROM public.equity_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND OR o.status <> 'pending' THEN
    RETURN; -- idempotent: ignore double-settlement
  END IF;

  IF p_status = 'filled' THEN
    UPDATE public.equity_orders
    SET status = 'filled', usdc_micro = p_usdc_micro, shares = p_shares,
        broker_ref = p_broker_ref, updated_at = now()
    WHERE id = p_order_id;

    INSERT INTO public.portfolio_holdings (user_id, symbol, asset_type, provider, invested_cngn_micro, shares)
    VALUES (o.user_id, o.symbol, o.asset_type, o.provider, o.amount_cngn_micro, COALESCE(p_shares, 0))
    ON CONFLICT (user_id, symbol, provider) DO UPDATE
      SET invested_cngn_micro = public.portfolio_holdings.invested_cngn_micro + o.amount_cngn_micro,
          shares              = public.portfolio_holdings.shares + COALESCE(p_shares, 0),
          updated_at          = now();
  ELSE
    UPDATE public.wallets
    SET usdc_balance_micro = usdc_balance_micro + o.amount_cngn_micro, updated_at = now()
    WHERE user_id = o.user_id;

    UPDATE public.equity_orders
    SET status = 'refunded', error = p_error, updated_at = now()
    WHERE id = p_order_id;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.place_equity_order(UUID, TEXT, TEXT, TEXT, BIGINT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.settle_equity_order(BIGINT, TEXT, BIGINT, NUMERIC, TEXT, TEXT) TO service_role;