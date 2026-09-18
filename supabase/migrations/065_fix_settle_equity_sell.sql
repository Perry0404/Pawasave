-- 065_fix_settle_equity_sell.sql
--
-- settle_equity_sell always failed with `column reference "fee_micro" is ambiguous`
-- (SQLSTATE 42702): the function declared a local variable `fee_micro` that collides with
-- the equity_sales.fee_micro column, so `SET fee_micro = fee_micro` couldn't be resolved.
-- Net effect: NO sell could ever settle — the on-chain stock→USDC→cNGN completed, but the
-- user was never credited and the ₦500 fee was never booked.
--
-- Fix: rename the locals (v_fee_micro / v_net_micro / v_ref) so column references are
-- unambiguous. Behaviour otherwise identical to 062. Idempotent (CREATE OR REPLACE).

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
  IF NOT FOUND OR s.status <> 'pending' THEN
    RETURN; -- idempotent
  END IF;

  IF p_status = 'filled' THEN
    -- Never let the fee exceed the proceeds; net is what the user receives.
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

    -- Credit the user their cNGN (net of the fee). credit_wallet: naira_kobo=0, cNGN in micro.
    PERFORM public.credit_wallet(s.user_id, 0, v_net_micro);

    INSERT INTO public.transactions (user_id, type, direction, amount_kobo, amount_usdc_micro,
                                     platform_fee_kobo, description, reference, status, metadata)
    VALUES (s.user_id, 'equity_sell', 'credit', 0, v_net_micro,
            (v_fee_micro / 10000), 'Sold ' || s.symbol || ' (₦500 fee)', v_ref, 'completed',
            jsonb_build_object('symbol', s.symbol, 'shares', s.shares, 'usdc_micro', p_usdc_micro,
                               'gross_micro', p_cngn_gross_micro, 'fee_micro', v_fee_micro));

    -- Book the ₦500 as platform revenue (kobo). Flat fee → percent 0.
    BEGIN
      PERFORM public.record_platform_fee(s.user_id, v_ref, 'equity_sell',
              (p_cngn_gross_micro / 10000), (v_fee_micro / 10000), 0);
    EXCEPTION WHEN OTHERS THEN /* fee-booking must not fail the credit */ NULL;
    END;
  ELSE
    -- Broker failed AFTER we reserved the shares: restore them.
    UPDATE public.portfolio_holdings
    SET shares = shares + s.shares, updated_at = now()
    WHERE user_id = s.user_id AND symbol = s.symbol AND provider = s.provider;

    UPDATE public.equity_sales
    SET status = 'failed', error = p_error, updated_at = now()
    WHERE id = s.id;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.settle_equity_sell(BIGINT, TEXT, BIGINT, BIGINT, TEXT, TEXT) TO service_role;
