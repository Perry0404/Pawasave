-- 062_equity_sell.sql
-- Sell side of the tokenized-stock desk + the flat ₦500 sell fee (buying is free).
--
-- Flow mirrors the buy: place_equity_sell RESERVES the shares (decrements the holding
-- and writes a 'pending' sale) in one transaction; the broker sells on-chain
-- (stock → USDC → cNGN via Uniswap V3 + HyperFX); settle_equity_sell then credits the
-- user's cNGN NET of a flat ₦500 fee (booked as platform revenue) — or, on broker
-- failure, restores the reserved shares. Idempotent settlement. Safe to run twice.
--
-- Fee: FLAT ₦500 per sell = 50,000 kobo = 500,000,000 cNGN micro. Not a percentage.
-- cNGN is held in wallets.usdc_balance_micro (6dp). The route must ensure the expected
-- proceeds exceed the fee BEFORE selling (the on-chain sale is irreversible).

-- ── widen ledger constraints for the new rows ────────────────────────────────
ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
ALTER TABLE public.transactions ADD CONSTRAINT transactions_type_check CHECK (type IN (
  'deposit', 'withdrawal', 'save_to_vault', 'vault_withdraw',
  'esusu_contribute', 'esusu_payout', 'emergency_payout',
  'split_auto_save', 'split_auto_esusu',
  'goal_contribute', 'goal_claim',
  'creator_incentive', 'cngn_pool_in',
  'loan_disbursement', 'loan_repayment', 'loan_liquidation',
  'equity_buy', 'equity_sell'
));

ALTER TABLE public.platform_fees DROP CONSTRAINT IF EXISTS platform_fees_fee_type_check;
ALTER TABLE public.platform_fees ADD CONSTRAINT platform_fees_fee_type_check CHECK (fee_type IN (
  'ramp_onramp', 'ramp_offramp', 'vault_lock_penalty', 'admin_revenue_withdrawal',
  'esusu_penalty', 'xauto_spread', 'goal_break_penalty', 'loan_origination',
  'equity_sell'
));

-- ── sales table ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.equity_sales (
  id               BIGSERIAL PRIMARY KEY,
  user_id          UUID NOT NULL,
  symbol           TEXT NOT NULL,
  provider         TEXT NOT NULL,
  shares           NUMERIC NOT NULL CHECK (shares > 0),   -- shares reserved/sold
  usdc_micro       BIGINT,                                -- USDC from the stock (on fill)
  cngn_gross_micro BIGINT,                                -- cNGN from HyperFX before fee
  fee_micro        BIGINT,                                -- flat ₦500 fee actually taken
  cngn_net_micro   BIGINT,                                -- cNGN credited to the user
  broker_ref       TEXT,
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'filled', 'failed')),
  error            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_equity_sales_user ON public.equity_sales (user_id, created_at DESC);

ALTER TABLE public.equity_sales ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sales_owner_read ON public.equity_sales;
CREATE POLICY sales_owner_read ON public.equity_sales FOR SELECT USING (auth.uid() = user_id);

-- ── place_equity_sell: reserve shares + pending sale ─────────────────────────
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

  SELECT kyc_status INTO v_kyc FROM public.profiles WHERE id = p_user_id;
  IF v_kyc IS DISTINCT FROM 'verified' THEN
    RAISE EXCEPTION 'place_equity_sell: KYC not verified';
  END IF;

  SELECT * INTO h FROM public.portfolio_holdings
    WHERE user_id = p_user_id AND symbol = upper(p_symbol) AND provider = p_provider FOR UPDATE;
  IF NOT FOUND OR h.shares < p_shares THEN
    RAISE EXCEPTION 'place_equity_sell: insufficient shares';
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

-- ── settle_equity_sell: credit cNGN net of the flat ₦500 fee, or restore shares ─
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
  s          public.equity_sales%rowtype;
  fee_micro  BIGINT := 500000000;   -- flat ₦500 = 500,000,000 cNGN micro
  net_micro  BIGINT;
  ref        TEXT;
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
    fee_micro := LEAST(fee_micro, p_cngn_gross_micro);
    net_micro := p_cngn_gross_micro - fee_micro;
    ref := COALESCE(p_broker_ref, 'equity_sell_' || s.id);

    UPDATE public.equity_sales
    SET status = 'filled', usdc_micro = p_usdc_micro, cngn_gross_micro = p_cngn_gross_micro,
        fee_micro = fee_micro, cngn_net_micro = net_micro, broker_ref = p_broker_ref, updated_at = now()
    WHERE id = s.id;

    -- Credit the user their cNGN (net of the fee). credit_wallet: naira_kobo=0, cNGN in micro.
    PERFORM public.credit_wallet(s.user_id, 0, net_micro);

    INSERT INTO public.transactions (user_id, type, direction, amount_kobo, amount_usdc_micro,
                                     platform_fee_kobo, description, reference, status, metadata)
    VALUES (s.user_id, 'equity_sell', 'credit', 0, net_micro,
            (fee_micro / 10000), 'Sold ' || s.symbol || ' (₦500 fee)', ref, 'completed',
            jsonb_build_object('symbol', s.symbol, 'shares', s.shares, 'usdc_micro', p_usdc_micro,
                               'gross_micro', p_cngn_gross_micro, 'fee_micro', fee_micro));

    -- Book the ₦500 as platform revenue (kobo). Flat fee → percent 0.
    BEGIN
      PERFORM public.record_platform_fee(s.user_id, ref, 'equity_sell',
              (p_cngn_gross_micro / 10000), (fee_micro / 10000), 0);
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

GRANT EXECUTE ON FUNCTION public.place_equity_sell(UUID, TEXT, TEXT, NUMERIC) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.settle_equity_sell(BIGINT, TEXT, BIGINT, BIGINT, TEXT, TEXT) TO service_role;
