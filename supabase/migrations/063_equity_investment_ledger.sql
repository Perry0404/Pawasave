-- 063_equity_investment_ledger.sql
--
-- Tokenized-stock BUYS were filling (holdings credited on-chain) but NOT booking a
-- `transactions` row — so they never appeared in the admin ledger and never counted in
-- `admin_tx_volume`'s investment total (it kept returning total_investments_kobo = 0).
--
-- Root cause: migration 057 redefined settle_equity_order to insert an 'investment'
-- transactions row on fill, but only 057's admin_tx_volume half reached production — the
-- settle_equity_order half was never applied, so the LIVE function was still 032's
-- (updates portfolio_holdings, writes no ledger row). This re-applies the 057 function and
-- backfills every already-filled order that is missing its ledger row (currently order #14,
-- the first real buy). Fully idempotent — safe to run more than once.
--
-- Run AFTER 057. (If 057 was skipped entirely, run 056 first so admin_tx_volume's
-- total_investments_kobo column exists.)

-- 0) Widen transactions.type — neither 056 (which added 'investment') nor 062 (which added
--    'equity_buy'/'equity_sell') fully reached prod, so the live constraint rejects the
--    'investment' type this ledger insert uses. Re-assert the full UNION of every type the
--    app writes, including 'investment'. Verified against live data: all existing rows use
--    deposit / withdrawal / save_to_vault / vault_withdraw / goal_contribute / goal_claim,
--    all present below, so the re-add validates cleanly.
ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
ALTER TABLE public.transactions ADD CONSTRAINT transactions_type_check CHECK (type IN (
  'deposit', 'withdrawal', 'save_to_vault', 'vault_withdraw',
  'esusu_contribute', 'esusu_payout', 'emergency_payout',
  'split_auto_save', 'split_auto_esusu',
  'goal_contribute', 'goal_claim',
  'creator_incentive', 'cngn_pool_in',
  'loan_disbursement', 'loan_repayment', 'loan_liquidation',
  'equity_buy', 'equity_sell', 'investment'
));

-- 1) settle_equity_order — on fill: update the order, upsert the holding, AND book an
--    'investment' transactions row (so buys show in the ledger and in admin volume).
--    On failure: refund the debited cNGN (stored in wallets.usdc_balance_micro) and mark
--    the order refunded. Body identical to 057.
CREATE OR REPLACE FUNCTION public.settle_equity_order(
  p_order_id   BIGINT,
  p_status     TEXT,
  p_usdc_micro BIGINT DEFAULT NULL,
  p_shares     NUMERIC DEFAULT NULL,
  p_broker_ref TEXT DEFAULT NULL,
  p_error      TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE o public.equity_orders%rowtype;
BEGIN
  SELECT * INTO o FROM public.equity_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND OR o.status <> 'pending' THEN
    RETURN; -- idempotent
  END IF;

  IF p_status = 'filled' THEN
    UPDATE public.equity_orders
    SET status = 'filled', usdc_micro = p_usdc_micro, shares = p_shares,
        broker_ref = p_broker_ref, updated_at = now()
    WHERE id = p_order_id;

    INSERT INTO public.portfolio_holdings (user_id, symbol, asset_type, provider, invested_cngn_micro, shares)
    VALUES (o.user_id, o.symbol, o.asset_type, o.provider, o.amount_cngn_micro, COALESCE(p_shares, 0))
    ON CONFLICT (user_id, symbol, provider) DO UPDATE
      SET invested_cngn_micro = public.portfolio_holdings.invested_cngn_micro + o.amount_cngn_micro,
          shares              = public.portfolio_holdings.shares + COALESCE(p_shares, 0),
          updated_at          = now();

    INSERT INTO public.transactions
      (user_id, type, direction, amount_kobo, amount_usdc_micro, description, reference, status, metadata)
    VALUES
      (o.user_id, 'investment', 'debit', FLOOR(o.amount_cngn_micro / 10000), o.amount_cngn_micro,
       'Invested in ' || o.symbol, 'equity_' || o.id::text, 'completed',
       jsonb_build_object('channel', 'Equity', 'symbol', o.symbol, 'asset_type', o.asset_type,
                          'provider', o.provider, 'shares', p_shares, 'broker_ref', p_broker_ref));
    -- (No ON CONFLICT needed: the `o.status <> 'pending'` guard above already makes a
    --  re-settle of the same order a no-op, so this row is inserted at most once.)
  ELSE
    UPDATE public.wallets
    SET usdc_balance_micro = usdc_balance_micro + o.amount_cngn_micro, updated_at = now()
    WHERE user_id = o.user_id;

    UPDATE public.equity_orders
    SET status = 'refunded', error = p_error, updated_at = now()
    WHERE id = p_order_id;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.settle_equity_order(BIGINT, TEXT, BIGINT, NUMERIC, TEXT, TEXT) TO service_role;

-- 2) Backfill: any order already 'filled' but missing its 'investment' ledger row.
--    Guarded by NOT EXISTS on the reference, so re-running this migration is a no-op.
INSERT INTO public.transactions
  (user_id, type, direction, amount_kobo, amount_usdc_micro, description, reference, status, metadata)
SELECT
  o.user_id, 'investment', 'debit', FLOOR(o.amount_cngn_micro / 10000), o.amount_cngn_micro,
  'Invested in ' || o.symbol, 'equity_' || o.id::text, 'completed',
  jsonb_build_object('channel', 'Equity', 'symbol', o.symbol, 'asset_type', o.asset_type,
                     'provider', o.provider, 'shares', o.shares, 'broker_ref', o.broker_ref,
                     'backfilled', true)
FROM public.equity_orders o
WHERE o.status = 'filled'
  AND NOT EXISTS (
    SELECT 1 FROM public.transactions t WHERE t.reference = 'equity_' || o.id::text
  );
