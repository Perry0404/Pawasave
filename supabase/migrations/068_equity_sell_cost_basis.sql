-- 068_equity_sell_cost_basis.sql
-- Fix tokenized-stock cost basis on SELL, so a partial sale doesn't show a fake loss.
--
-- Bug: place_equity_sell reduced portfolio_holdings.shares when you sold, but NOTHING
-- ever reduced invested_cngn_micro (the cost basis). settle_equity_sell (fill) credits
-- cNGN and books the fee but doesn't touch the holding either. Result: after selling
-- part of a position, the remaining shares are valued against the FULL original cost —
-- e.g. bought AAPL twice for ₦2,000 (0.00435 sh), sold half (0.00219 sh); the holding
-- correctly showed 0.00216 sh but still ₦2,000 invested, so the app showed a ~₦895
-- "loss" on shares actually worth ~₦1,110 (a real profit). Shares were fine; cost basis
-- was not. This is a ledger/display bug — custody held the correct tokens throughout.
--
-- Fix (average-cost): when shares are sold, reduce invested_cngn_micro by the same
-- proportion, remembering how much we removed so a FAILED sell can restore it. Also
-- relaxes the sell identity gate to match place_equity_order (064): Strails-onboarded
-- users can sell, not only Sense-verified ones. Idempotent. Backfills existing holdings.

-- 1) Remember the cost basis removed by each reservation (for failed-sell restore).
ALTER TABLE public.equity_sales
  ADD COLUMN IF NOT EXISTS invested_removed_micro BIGINT NOT NULL DEFAULT 0;

-- 2) place_equity_sell — reserve shares AND reduce cost basis proportionally.
CREATE OR REPLACE FUNCTION public.place_equity_sell(
  p_user_id  UUID,
  p_symbol   TEXT,
  p_provider TEXT,
  p_shares   NUMERIC
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  h            public.portfolio_holdings%rowtype;
  v_kyc        TEXT;
  v_onb        TEXT;
  v_va         TEXT;
  v_sale       BIGINT;
  v_cost_rm    BIGINT;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() != p_user_id THEN
    RAISE EXCEPTION 'place_equity_sell: unauthorized';
  END IF;
  IF p_shares IS NULL OR p_shares <= 0 THEN
    RAISE EXCEPTION 'place_equity_sell: shares must be positive';
  END IF;

  -- Identity gate mirrors place_equity_order (064): Sense-verified OR Strails onboarding.
  SELECT kyc_status, strails_onboard_status, strails_va_account_number
    INTO v_kyc, v_onb, v_va FROM public.profiles WHERE id = p_user_id;
  IF NOT (v_kyc = 'verified' OR v_onb = 'completed' OR v_va IS NOT NULL) THEN
    RAISE EXCEPTION 'place_equity_sell: identity not verified';
  END IF;

  SELECT * INTO h FROM public.portfolio_holdings
    WHERE user_id = p_user_id AND symbol = upper(p_symbol) AND provider = p_provider FOR UPDATE;
  IF NOT FOUND OR h.shares < p_shares THEN
    RAISE EXCEPTION 'place_equity_sell: insufficient shares';
  END IF;

  -- Average-cost: remove the same fraction of cost basis as of shares sold.
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
GRANT EXECUTE ON FUNCTION public.place_equity_sell(UUID, TEXT, TEXT, NUMERIC) TO authenticated, service_role;

-- 3) settle_equity_sell — on FAIL, restore BOTH shares and the removed cost basis.
--    Fill path unchanged from 065 (credits net, books ₦500 fee; holding already adjusted
--    at reservation). Keeps the v_-prefixed locals from 065 (avoids the fee_micro clash).
CREATE OR REPLACE FUNCTION public.settle_equity_sell(
  p_sale_id          BIGINT,
  p_status           TEXT,
  p_usdc_micro       BIGINT DEFAULT NULL,
  p_cngn_gross_micro BIGINT DEFAULT NULL,
  p_broker_ref       TEXT   DEFAULT NULL,
  p_error            TEXT   DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  s            public.equity_sales%rowtype;
  v_fee_micro  BIGINT := 500000000;
  v_net_micro  BIGINT;
  v_ref        TEXT;
BEGIN
  SELECT * INTO s FROM public.equity_sales WHERE id = p_sale_id FOR UPDATE;
  IF NOT FOUND OR s.status <> 'pending' THEN
    RETURN; -- idempotent
  END IF;

  IF p_status = 'filled' THEN
    IF p_cngn_gross_micro IS NULL OR p_cngn_gross_micro <= 0 THEN
      RAISE EXCEPTION 'settle_equity_sell: gross required on fill';
    END IF;
    v_fee_micro := LEAST(v_fee_micro, p_cngn_gross_micro);
    v_net_micro := p_cngn_gross_micro - v_fee_micro;
    v_ref := COALESCE(p_broker_ref, 'equity_sell_' || s.id);

    UPDATE public.equity_sales
    SET status = 'filled', usdc_micro = p_usdc_micro, cngn_gross_micro = p_cngn_gross_micro,
        fee_micro = v_fee_micro, cngn_net_micro = v_net_micro, broker_ref = p_broker_ref, updated_at = now()
    WHERE id = s.id;

    PERFORM public.credit_wallet(s.user_id, 0, v_net_micro);

    INSERT INTO public.transactions (user_id, type, direction, amount_kobo, amount_usdc_micro,
                                     platform_fee_kobo, description, reference, status, metadata)
    VALUES (s.user_id, 'equity_sell', 'credit', 0, v_net_micro,
            (v_fee_micro / 10000), 'Sold ' || s.symbol || ' (₦500 fee)', v_ref, 'completed',
            jsonb_build_object('symbol', s.symbol, 'shares', s.shares, 'usdc_micro', p_usdc_micro,
                               'gross_micro', p_cngn_gross_micro, 'fee_micro', v_fee_micro));

    BEGIN
      PERFORM public.record_platform_fee(s.user_id, v_ref, 'equity_sell',
              (p_cngn_gross_micro / 10000), (v_fee_micro / 10000), 0);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  ELSE
    -- Broker failed after reservation: restore the shares AND the cost basis removed.
    UPDATE public.portfolio_holdings
    SET shares              = shares + s.shares,
        invested_cngn_micro = invested_cngn_micro + COALESCE(s.invested_removed_micro, 0),
        updated_at = now()
    WHERE user_id = s.user_id AND symbol = s.symbol AND provider = s.provider;

    UPDATE public.equity_sales
    SET status = 'failed', error = p_error, updated_at = now()
    WHERE id = s.id;
  END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION public.settle_equity_sell(BIGINT, TEXT, BIGINT, BIGINT, TEXT, TEXT) TO service_role;

-- 4) Backfill: recompute every holding's cost basis on an average-cost basis from its
--    filled buy history, scaled to the shares still held. Holdings with no sells are
--    unchanged (shares held == shares bought → same invested). Fixes rows corrupted
--    before this migration (e.g. the AAPL holding that showed a fake ~₦895 loss).
UPDATE public.portfolio_holdings ph
SET invested_cngn_micro = sub.corrected
FROM (
  SELECT ph2.id,
         FLOOR(b.total_invested::numeric * (ph2.shares / b.total_shares))::bigint AS corrected
  FROM public.portfolio_holdings ph2
  JOIN (
    SELECT user_id, upper(symbol) AS symbol, provider,
           SUM(amount_cngn_micro) AS total_invested,
           SUM(shares)            AS total_shares
    FROM public.equity_orders
    WHERE status = 'filled' AND shares IS NOT NULL
    GROUP BY user_id, upper(symbol), provider
  ) b ON b.user_id = ph2.user_id AND b.symbol = ph2.symbol AND b.provider = ph2.provider
  WHERE b.total_shares > 0
) sub
WHERE ph.id = sub.id;
