-- 109_block_pledged_equity_sell.sql
--
-- Stop a borrower selling the stock that is securing their loan.
--
-- THE HOLE: create_loan (042) pledges collateral by stamping pledged_loan_id on both
-- savings_locks and portfolio_holdings. withdraw_lock checks it and refuses
-- (042:389 `IF v_lock.pledged_loan_id IS NOT NULL THEN RETURN false`), so a pledged savings
-- lock is safe. place_equity_sell never looked at it. So: pledge ₦500k of stock, borrow
-- against it, sell the stock, keep the cNGN. The loan is left with nothing behind it, and
-- liquidate_loan later finds shares = 0 and recovers nothing.
--
-- Same asymmetry, same fix as the lock side. A pledged holding is frozen until the loan is
-- repaid, at which point repay_loan clears pledged_loan_id (042:280-281) and it sells again.
--
-- This is the UNION of 098 plus the new check, for the reason 098 itself exists: 088 was
-- written from an older body and silently reverted two fixes. Diff against 098 before
-- editing, and keep every gate.
--
-- MANUAL STEP: none. No data changes, one function replaced.

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

  -- NEW (109): the holding is securing a loan. Selling it would strip the collateral and
  -- leave the debt unbacked. repay_loan clears this, so the position is frozen, not lost.
  IF h.pledged_loan_id IS NOT NULL THEN
    RAISE EXCEPTION 'place_equity_sell: pledged as loan collateral';
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
