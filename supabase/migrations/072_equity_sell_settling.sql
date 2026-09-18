-- 072_equity_sell_settling.sql  (run after 068)
--
-- Fixes the two-leg sell atomicity hole that stranded a TSLA sale (2026-09-07).
-- A sell is: (1) stock → USDC on-chain [IRREVERSIBLE], then (2) USDC → cNGN via HyperFX.
-- If leg 2 found no solver, the old flow settled 'failed' and RESTORED the shares — but
-- the stock was already sold on-chain, so the ledger then claimed shares custody no longer
-- held, and every retry failed "insufficient custody balance". The USDC sat idle.
--
-- Fix: a new 'settling' state. When leg 1 has sold the stock but leg 2 can't fill yet, the
-- sale is parked as 'settling' (USDC recorded) — shares are NOT restored — and the
-- equity-sell-reconcile cron retries USDC→cNGN until a solver fills, then settles 'filled'.
-- settle_equity_sell now accepts pending→(filled|failed) AND settling→filled, and only
-- restores shares when the sale was still 'pending' (leg 1 never executed). Idempotent.

-- ── allow the new status ─────────────────────────────────────────────────────
ALTER TABLE public.equity_sales DROP CONSTRAINT IF EXISTS equity_sales_status_check;
ALTER TABLE public.equity_sales ADD CONSTRAINT equity_sales_status_check
  CHECK (status IN ('pending', 'settling', 'filled', 'failed'));

-- ── park a sale as settling: stock sold to USDC, cNGN conversion pending ──────
-- Records the USDC now sitting in custody + the stock-sell tx. Does NOT touch the
-- holding (the shares are genuinely gone on-chain). Only a 'pending' sale can move here.
CREATE OR REPLACE FUNCTION public.mark_equity_sell_settling(
  p_sale_id    BIGINT,
  p_usdc_micro BIGINT,
  p_broker_ref TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE public.equity_sales
  SET status     = 'settling',
      usdc_micro = p_usdc_micro,
      broker_ref = COALESCE(p_broker_ref, broker_ref),
      updated_at = now()
  WHERE id = p_sale_id AND status = 'pending';
END;
$$;
GRANT EXECUTE ON FUNCTION public.mark_equity_sell_settling(BIGINT, BIGINT, TEXT) TO service_role;

-- ── settle: pending|settling → filled (credit cNGN), pending → failed (restore) ─
CREATE OR REPLACE FUNCTION public.settle_equity_sell(
  p_sale_id          BIGINT,
  p_status           TEXT,               -- 'filled' | 'failed'
  p_usdc_micro       BIGINT DEFAULT NULL,
  p_cngn_gross_micro BIGINT DEFAULT NULL,
  p_broker_ref       TEXT   DEFAULT NULL,
  p_error            TEXT   DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  s            public.equity_sales%rowtype;
  v_fee_micro  BIGINT := 500000000;   -- flat ₦500 = 500,000,000 cNGN micro
  v_net_micro  BIGINT;
  v_ref        TEXT;
BEGIN
  SELECT * INTO s FROM public.equity_sales WHERE id = p_sale_id FOR UPDATE;
  -- A fill may complete a 'pending' (fast path) or a parked 'settling' sale (cron path).
  -- A fail only makes sense while still 'pending' (leg 1 never sold the stock).
  IF NOT FOUND OR s.status NOT IN ('pending', 'settling') THEN
    RETURN; -- idempotent
  END IF;

  IF p_status = 'filled' THEN
    IF p_cngn_gross_micro IS NULL OR p_cngn_gross_micro <= 0 THEN
      RAISE EXCEPTION 'settle_equity_sell: gross required on fill';
    END IF;
    v_fee_micro := LEAST(v_fee_micro, p_cngn_gross_micro);
    v_net_micro := p_cngn_gross_micro - v_fee_micro;
    v_ref := COALESCE(p_broker_ref, s.broker_ref, 'equity_sell_' || s.id);

    UPDATE public.equity_sales
    SET status = 'filled', usdc_micro = COALESCE(p_usdc_micro, usdc_micro),
        cngn_gross_micro = p_cngn_gross_micro, fee_micro = v_fee_micro,
        cngn_net_micro = v_net_micro, broker_ref = COALESCE(p_broker_ref, broker_ref),
        updated_at = now()
    WHERE id = s.id;

    -- Credit the user their cNGN (net of the fee). credit_wallet: naira_kobo=0, cNGN micro.
    PERFORM public.credit_wallet(s.user_id, 0, v_net_micro);

    INSERT INTO public.transactions (user_id, type, direction, amount_kobo, amount_usdc_micro,
                                     platform_fee_kobo, description, reference, status, metadata)
    VALUES (s.user_id, 'equity_sell', 'credit', 0, v_net_micro,
            (v_fee_micro / 10000), 'Sold ' || s.symbol || ' (₦500 fee)', v_ref, 'completed',
            jsonb_build_object('symbol', s.symbol, 'shares', s.shares, 'usdc_micro', COALESCE(p_usdc_micro, s.usdc_micro),
                               'gross_micro', p_cngn_gross_micro, 'fee_micro', v_fee_micro));

    BEGIN
      PERFORM public.record_platform_fee(s.user_id, v_ref, 'equity_sell',
              (p_cngn_gross_micro / 10000), (v_fee_micro / 10000), 0);
    EXCEPTION WHEN OTHERS THEN /* fee-booking must not fail the credit */ NULL;
    END;
  ELSE
    -- Broker failed. Only restore shares if leg 1 never executed (still 'pending').
    -- A 'settling' sale has already sold the stock on-chain — restoring would re-create
    -- phantom shares custody doesn't hold, so leave it parked for the reconcile cron.
    IF s.status = 'pending' THEN
      UPDATE public.portfolio_holdings
      SET shares = shares + s.shares, updated_at = now()
      WHERE user_id = s.user_id AND symbol = s.symbol AND provider = s.provider;

      UPDATE public.equity_sales
      SET status = 'failed', error = p_error, updated_at = now()
      WHERE id = s.id;
    END IF;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.settle_equity_sell(BIGINT, TEXT, BIGINT, BIGINT, TEXT, TEXT) TO service_role;
