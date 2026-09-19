-- 088_block_rwa_equity_sell.sql
-- Stop RWA / IPO positions being sold through the tokenized-stock desk.
--
-- WHY: place_equity_sell (062) reserves a holding by (symbol, provider) with no
-- asset_type guard. The DEX sell path (lib/equity-broker.sellEquity) only knows how
-- to sell base_dex tokenized stocks — an RWA/IPO position (e.g. DPRI, bought via
-- GetEquity: asset_type='rwa', provider='getequity') has no DEX route, and a pre-IPO
-- share must not be dumped on a DEX before it lists. The UI already hides the Sell
-- button for non-stock holdings, but that is presentation only; this makes the block
-- authoritative so it holds even from a stale client or a direct API call.
--
-- Only positions that the desk can actually settle are sellable here:
--   provider = 'base_dex' AND asset_type IN ('tokenized_stock','pre_ipo').
-- GetEquity RWAs exit via redemption / maturity, not this path.

CREATE OR REPLACE FUNCTION public.place_equity_sell(
  p_user_id  UUID,
  p_symbol   TEXT,
  p_provider TEXT,
  p_shares   NUMERIC
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  h       public.portfolio_holdings%rowtype;
  v_kyc   TEXT;
  v_sale  BIGINT;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() != p_user_id THEN
    RAISE EXCEPTION 'place_equity_sell: unauthorized';
  END IF;
  IF p_shares IS NULL OR p_shares <= 0 THEN
    RAISE EXCEPTION 'place_equity_sell: shares must be positive';
  END IF;

  -- Only the DEX desk can settle a sale here. Reject GetEquity/RWA up front with a
  -- clear message (rather than failing later at the broker or on a provider mismatch).
  IF p_provider IS DISTINCT FROM 'base_dex' THEN
    RAISE EXCEPTION 'place_equity_sell: this asset cannot be sold in the app yet';
  END IF;

  SELECT kyc_status INTO v_kyc FROM public.profiles WHERE id = p_user_id;
  IF v_kyc IS DISTINCT FROM 'verified' THEN
    RAISE EXCEPTION 'place_equity_sell: KYC not verified';
  END IF;

  SELECT * INTO h FROM public.portfolio_holdings
    WHERE user_id = p_user_id AND symbol = upper(p_symbol) AND provider = p_provider FOR UPDATE;
  IF NOT FOUND OR h.shares < p_shares THEN
    RAISE EXCEPTION 'place_equity_sell: insufficient shares';
  END IF;

  -- Defence in depth: even under base_dex, refuse anything that is not a DEX-tradeable
  -- equity (a stray 'rwa' row must never be routed to the stock desk).
  IF h.asset_type NOT IN ('tokenized_stock', 'pre_ipo') THEN
    RAISE EXCEPTION 'place_equity_sell: this asset cannot be sold in the app yet';
  END IF;

  UPDATE public.portfolio_holdings
  SET shares = shares - p_shares, updated_at = now()
  WHERE id = h.id;

  INSERT INTO public.equity_sales (user_id, symbol, provider, shares)
  VALUES (p_user_id, upper(p_symbol), p_provider, p_shares)
  RETURNING id INTO v_sale;

  RETURN v_sale;
END;
$$;

REVOKE ALL ON FUNCTION public.place_equity_sell(UUID, TEXT, TEXT, NUMERIC) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.place_equity_sell(UUID, TEXT, TEXT, NUMERIC) TO authenticated, service_role;
