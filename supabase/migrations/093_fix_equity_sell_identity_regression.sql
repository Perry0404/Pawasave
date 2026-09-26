-- 093_fix_equity_sell_identity_regression.sql
-- Fix a regression that 088 introduced into place_equity_sell.
--
-- WHAT BROKE: migration 068 had relaxed place_equity_sell to (a) accept Strails BVN
-- onboarding as identity (not only Sense 'verified'), and (b) reduce invested_cngn_micro
-- proportionally on a sale (average-cost, with invested_removed_micro so a failed sell
-- restores it). Migration 088 then CREATE OR REPLACE'd place_equity_sell to add the
-- RWA/asset_type block — but was written from the older 062 body, so it silently REVERTED
-- both of 068's fixes: it went back to a strict `kyc_status = 'verified'` gate and dropped
-- the cost-basis reduction.
--
-- SYMPTOM: a BVN-onboarded user (kyc_status='pending', strails_onboard_status='completed')
-- passes the /api/invest/equity/sell route's identity check, then place_equity_sell throws
-- "KYC not verified" — surfaced to the user as the generic "Could not place sell order",
-- with no equity_sales row ever created. (Confirmed live: seller 8166da1e is 'pending' +
-- Strails-completed; only the one 'verified' holder could sell.) This has nothing to do
-- with HyperFX — placement fails before the broker/leg-2 is ever touched.
--
-- THIS FIX: recreate place_equity_sell as the UNION of 068 + 088 —
--   * identity gate: verified OR Strails onboarded (068 / 064),
--   * average-cost basis reduction + invested_removed_micro (068),
--   * base_dex-only provider gate + tokenized_stock/pre_ipo asset_type gate (088).
-- settle_equity_sell is unchanged (068's version is current and correct).

CREATE OR REPLACE FUNCTION public.place_equity_sell(
  p_user_id  UUID,
  p_symbol   TEXT,
  p_provider TEXT,
  p_shares   NUMERIC
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  h          public.portfolio_holdings%rowtype;
  v_kyc      TEXT;
  v_onb      TEXT;
  v_va       TEXT;
  v_sale     BIGINT;
  v_cost_rm  BIGINT;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() != p_user_id THEN
    RAISE EXCEPTION 'place_equity_sell: unauthorized';
  END IF;
  IF p_shares IS NULL OR p_shares <= 0 THEN
    RAISE EXCEPTION 'place_equity_sell: shares must be positive';
  END IF;

  -- Only the DEX desk can settle a sale here (088). Reject GetEquity/RWA up front.
  IF p_provider IS DISTINCT FROM 'base_dex' THEN
    RAISE EXCEPTION 'place_equity_sell: this asset cannot be sold in the app yet';
  END IF;

  -- Identity gate mirrors place_equity_order (064) and place_getequity_order (056):
  -- Sense-verified OR completed Strails BVN onboarding (a VA number proves onboarding).
  SELECT kyc_status, strails_onboard_status, strails_va_account_number
    INTO v_kyc, v_onb, v_va FROM public.profiles WHERE id = p_user_id;
  IF NOT (v_kyc = 'verified' OR v_onb = 'completed' OR COALESCE(v_va, '') <> '') THEN
    RAISE EXCEPTION 'place_equity_sell: identity not verified';
  END IF;

  SELECT * INTO h FROM public.portfolio_holdings
    WHERE user_id = p_user_id AND symbol = upper(p_symbol) AND provider = p_provider FOR UPDATE;
  IF NOT FOUND OR h.shares < p_shares THEN
    RAISE EXCEPTION 'place_equity_sell: insufficient shares';
  END IF;

  -- Defence in depth (088): even under base_dex, refuse anything not DEX-tradeable.
  IF h.asset_type NOT IN ('tokenized_stock', 'pre_ipo') THEN
    RAISE EXCEPTION 'place_equity_sell: this asset cannot be sold in the app yet';
  END IF;

  -- Average-cost (068): remove the same fraction of cost basis as of shares sold, and
  -- remember it (invested_removed_micro) so a failed sell can restore it exactly.
  v_cost_rm := FLOOR(h.invested_cngn_micro::numeric * (p_shares / h.shares));
  IF v_cost_rm > h.invested_cngn_micro THEN v_cost_rm := h.invested_cngn_micro; END IF;

  UPDATE public.portfolio_holdings
  SET shares              = shares - p_shares,
      invested_cngn_micro = GREATEST(0, invested_cngn_micro - v_cost_rm),
      updated_at = now()
  WHERE id = h.id;

  INSERT INTO public.equity_sales (user_id, symbol, provider, shares, invested_removed_micro)
  VALUES (p_user_id, upper(p_symbol), p_provider, p_shares, v_cost_rm)
  RETURNING id INTO v_sale;

  RETURN v_sale;
END;
$$;

REVOKE ALL ON FUNCTION public.place_equity_sell(UUID, TEXT, TEXT, NUMERIC) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.place_equity_sell(UUID, TEXT, TEXT, NUMERIC) TO authenticated, service_role;
