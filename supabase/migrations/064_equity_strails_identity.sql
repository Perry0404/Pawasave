-- 064_equity_strails_identity.sql
--
-- Accept Strails BVN onboarding as the identity check for BUYING equities.
--
-- place_equity_order hard-required profiles.kyc_status = 'verified' (full Sense biometric).
-- But PawaSave's basic identity verification IS the Strails BVN onboarding — it's mandatory
-- to get a NUBAN, and government BVN matching is what gates a real person. Sense biometric is
-- only needed to lift withdrawal caps, NOT to invest. Result: users who completed Strails
-- onboarding (BVN-verified) but haven't done Sense were wrongly blocked from buying — they hit
-- "KYC not verified" on every stock. (Observed: 5 onboarded users, 4 of them kyc_status<>verified.)
--
-- Relax the check to accept EITHER Sense-verified OR a completed Strails onboarding. Mirrors
-- the API/UI gate. Idempotent (CREATE OR REPLACE); body otherwise identical to 032.

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
  v_onb    TEXT;
  v_va     TEXT;
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

  -- Basic identity: Sense-verified OR completed Strails BVN onboarding (either proves BVN).
  SELECT kyc_status, strails_onboard_status, strails_va_account_number
    INTO v_kyc, v_onb, v_va
    FROM public.profiles WHERE id = p_user_id;
  IF NOT (v_kyc = 'verified' OR v_onb = 'completed' OR v_va IS NOT NULL) THEN
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
