-- 110_invest_identity_null_safe.sql
--
-- The invest identity gates never fire for a profile with NULL onboarding columns.
--
-- THE BUG: all three gates are written `IF NOT (a OR b OR c) THEN RAISE`. In SQL a NULL
-- comparison is NULL, not false, and NULL propagates:
--
--   kyc_status='pending'          -> 'pending' = 'verified'    -> false
--   strails_onboard_status IS NULL-> NULL = 'completed'        -> NULL
--   strails_va_account_number NULL-> coalesce(...,'') <> ''    -> false
--   false OR NULL OR false = NULL ... NOT NULL = NULL ... IF NULL THEN -> skipped
--
-- So a user with no verification at all walks straight through. Confirmed against a real
-- profile: kyc_status 'pending', onboarding NULL, no VA number, and place_equity_sell
-- happily created a sale.
--
-- WHY IT MATTERS: these functions are GRANT EXECUTE TO authenticated, so they are callable
-- directly with an anon key and a user JWT. The TypeScript gate in the routes does evaluate
-- correctly, but a direct rpc() call never reaches it — the same shape as the four holes
-- migration 099 closed.
--
-- Affected: place_equity_order (064:44), place_equity_sell (098:57, carried into 109),
-- place_getequity_order (056:109).
--
-- THE FIX: one NULL-safe helper, has_invest_identity, and all three call it. The guard logic
-- now lives in a single place, so a future migration recreating one of these bodies cannot
-- quietly revert it — which is exactly what 088 did to 068.
--
-- BEHAVIOUR CHANGE, deliberate: 064 accepted `strails_va_account_number IS NOT NULL`, so an
-- empty string counted as a VA number. The helper requires it to be non-empty, matching 056
-- and 098. An empty string is not an account number.
--
-- This is the INVEST gate. It is deliberately looser than borrowing, which needs full
-- biometric KYC. Do not make loans call this helper. See spec R3.2 / R4.2.
--
-- MANUAL STEP: none. No data changes.

-- ── the gate, in one place ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.has_invest_identity(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT COALESCE((
    SELECT COALESCE(kyc_status, '') = 'verified'
        OR COALESCE(strails_onboard_status, '') = 'completed'
        OR COALESCE(strails_va_account_number, '') <> ''
      FROM public.profiles WHERE id = p_user_id
  ), false);
$$;

-- COALESCE around the subquery as well: a user_id with no profile row returns no row at all,
-- which is also NULL, and would poison the caller's IF the same way.

REVOKE ALL ON FUNCTION public.has_invest_identity(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_invest_identity(UUID) TO authenticated, service_role;

-- ── place_equity_order: body from 064, guard replaced ────────────────────────
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

  IF NOT public.has_invest_identity(p_user_id) THEN
    RAISE EXCEPTION 'place_equity_order: identity not verified';
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

REVOKE ALL ON FUNCTION public.place_equity_order(UUID, TEXT, TEXT, TEXT, BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.place_equity_order(UUID, TEXT, TEXT, TEXT, BIGINT) TO authenticated, service_role;

-- ── place_equity_sell: body from 109, guard replaced ─────────────────────────
CREATE OR REPLACE FUNCTION public.place_equity_sell(
  p_user_id  UUID,
  p_symbol   TEXT,
  p_provider TEXT,
  p_shares   NUMERIC
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  h          public.portfolio_holdings%rowtype;
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

  IF NOT public.has_invest_identity(p_user_id) THEN
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

  -- 109: the holding is securing a loan. Selling it would leave the debt unbacked.
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

-- ── place_getequity_order: body from 056, guard replaced ─────────────────────
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

  IF NOT public.has_invest_identity(p_user_id) THEN
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

REVOKE ALL ON FUNCTION public.place_getequity_order(UUID, TEXT, TEXT, BIGINT, BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.place_getequity_order(UUID, TEXT, TEXT, BIGINT, BIGINT) TO authenticated, service_role;
