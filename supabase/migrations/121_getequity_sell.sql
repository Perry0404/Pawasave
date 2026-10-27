-- 121_getequity_sell.sql — sell GetEquity holdings (Treasury Bills fund, Dangote IPO) in the app
--
-- Until now an asset bought through GetEquity (portfolio_holdings.asset_type = 'rwa',
-- provider = 'getequity') could be bought but not sold: 088 blocks rwa rows from the stock
-- desk because the stock desk sells on a DEX, and GetEquity assets don't trade there. They
-- trade on GetEquity's own Market contract, which has sell(). This adds that path.
--
--   place_getequity_sell   reserve the units (they leave the holding) and open a 'sell' order
--   settle_getequity_sell  filled → credit the proceeds net of PawaSave's fee to the spendable
--                          balance; failed → put the units and cost basis back
--
-- PawaSave's fee on a sale is a share of the GAIN only (passed in by the API, which computes
-- it from the cost basis reserved here). A sale at or below cost pays no fee. On the Treasury
-- Bills fund this is how "you earn 14% a year" works when the fund earns 14.5%: keeping
-- 0.5/14.5 of the gain (about 3.45%) leaves the saver 14% a year, with no buy fee and no
-- charge for exiting.
--
-- Pledged holdings (loan collateral) cannot be sold. Safe to re-run.

ALTER TABLE public.getequity_orders ADD COLUMN IF NOT EXISTS cost_basis_micro BIGINT;

-- Sell orders are opened before the proceeds are known; amount_cngn_micro holds the quoted
-- proceeds until settlement replaces it with the real figure.

CREATE OR REPLACE FUNCTION public.place_getequity_sell(
  p_user_id         UUID,
  p_symbol          TEXT,
  p_units           NUMERIC,
  p_quote_micro     BIGINT
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  h       public.portfolio_holdings%rowtype;
  v_cost  BIGINT;
  v_order BIGINT;
  v_token TEXT;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'place_getequity_sell: unauthorized';
  END IF;
  IF p_units IS NULL OR p_units <= 0 THEN
    RAISE EXCEPTION 'place_getequity_sell: units must be positive';
  END IF;
  IF p_quote_micro IS NULL OR p_quote_micro <= 0 THEN
    RAISE EXCEPTION 'place_getequity_sell: could not price this sale';
  END IF;

  SELECT * INTO h FROM public.portfolio_holdings
  WHERE user_id = p_user_id AND symbol = upper(p_symbol) AND provider = 'getequity' AND asset_type = 'rwa'
  FOR UPDATE;
  IF NOT FOUND OR h.shares < p_units THEN
    RAISE EXCEPTION 'place_getequity_sell: insufficient units';
  END IF;
  IF h.pledged_loan_id IS NOT NULL THEN
    RAISE EXCEPTION 'place_getequity_sell: this holding is securing a loan; repay the loan first';
  END IF;

  -- Cost basis of the units leaving, proportional (068 keeps invested_cngn_micro proportional).
  v_cost := CASE WHEN p_units >= h.shares THEN h.invested_cngn_micro
                 ELSE floor(h.invested_cngn_micro * (p_units / h.shares)) END;

  UPDATE public.portfolio_holdings
  SET shares = shares - p_units, invested_cngn_micro = invested_cngn_micro - v_cost, updated_at = now()
  WHERE id = h.id;

  -- The token address comes from the last filled buy of this symbol.
  SELECT token INTO v_token FROM public.getequity_orders
  WHERE user_id = p_user_id AND symbol = upper(p_symbol) AND side = 'buy' AND status = 'filled'
  ORDER BY id DESC LIMIT 1;

  INSERT INTO public.getequity_orders (user_id, symbol, token, side, amount_cngn_micro, units, cost_basis_micro)
  VALUES (p_user_id, upper(p_symbol), COALESCE(v_token, ''), 'sell', p_quote_micro, p_units, v_cost)
  RETURNING id INTO v_order;
  RETURN v_order;
END;
$$;
REVOKE ALL ON FUNCTION public.place_getequity_sell(UUID, TEXT, NUMERIC, BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.place_getequity_sell(UUID, TEXT, NUMERIC, BIGINT) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.settle_getequity_sell(
  p_order_id     BIGINT,
  p_status       TEXT,              -- 'filled' | 'failed'
  p_payout_micro BIGINT DEFAULT NULL, -- cNGN actually received on-chain
  p_fee_micro    BIGINT DEFAULT 0,    -- PawaSave's fee (share of the gain)
  p_tx_hash      TEXT DEFAULT NULL,
  p_error        TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  o     public.getequity_orders%rowtype;
  v_fee BIGINT;
  v_net BIGINT;
BEGIN
  SELECT * INTO o FROM public.getequity_orders WHERE id = p_order_id AND side = 'sell' FOR UPDATE;
  IF NOT FOUND OR o.status <> 'pending' THEN
    RETURN; -- idempotent
  END IF;

  IF p_status = 'filled' THEN
    IF p_payout_micro IS NULL OR p_payout_micro <= 0 THEN
      RAISE EXCEPTION 'settle_getequity_sell: payout required';
    END IF;
    v_fee := LEAST(GREATEST(COALESCE(p_fee_micro, 0), 0), p_payout_micro);
    v_net := p_payout_micro - v_fee;

    UPDATE public.getequity_orders
    SET status = 'filled', amount_cngn_micro = p_payout_micro, fee_cngn_micro = v_fee,
        tx_hash = p_tx_hash, updated_at = now()
    WHERE id = p_order_id;

    UPDATE public.wallets SET usdc_balance_micro = usdc_balance_micro + v_net, updated_at = now()
    WHERE user_id = o.user_id;

    INSERT INTO public.transactions
      (user_id, type, direction, amount_kobo, amount_usdc_micro, description, reference, status, metadata)
    VALUES
      (o.user_id, 'investment', 'credit', floor(v_net / 10000), v_net,
       'Sold ' || o.symbol, 'getequity_sell_' || o.id::text, 'completed',
       jsonb_build_object('channel', 'GetEquity', 'side', 'sell', 'symbol', o.symbol, 'units', o.units,
                          'tx_hash', p_tx_hash, 'gross_micro', p_payout_micro, 'fee_cngn_micro', v_fee,
                          'cost_basis_micro', o.cost_basis_micro));

    IF v_fee > 0 THEN
      INSERT INTO public.platform_fees (user_id, transaction_ref, fee_type, gross_amount_kobo, fee_amount_kobo, fee_percent)
      VALUES (o.user_id, 'getequity_sell_' || o.id::text, 'investment_fee',
              floor(p_payout_micro / 10000), floor(v_fee / 10000),
              round((v_fee::numeric / NULLIF(p_payout_micro, 0)) * 100, 2));
      UPDATE public.platform_settings
      SET value = (COALESCE(value::bigint, 0) + floor(v_fee / 10000))::text
      WHERE key = 'platform_revenue_kobo';
    END IF;
  ELSE
    -- Failed sale: the units never left custody on-chain, so give them back.
    UPDATE public.portfolio_holdings
    SET shares = shares + o.units, invested_cngn_micro = invested_cngn_micro + COALESCE(o.cost_basis_micro, 0), updated_at = now()
    WHERE user_id = o.user_id AND symbol = o.symbol AND provider = 'getequity';
    UPDATE public.getequity_orders SET status = 'failed', error = p_error, updated_at = now() WHERE id = p_order_id;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.settle_getequity_sell(BIGINT, TEXT, BIGINT, BIGINT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_getequity_sell(BIGINT, TEXT, BIGINT, BIGINT, TEXT, TEXT) TO service_role;
