-- 019_auto_proxy_deposit.sql
-- Automates proxy member deposits: removes manual admin proxy transfer requirement
-- When Xend confirms a proxy deposit, automatically credit the user and allocate to pool

-- RPC to process proxy deposit automatically
-- Called by Xend webhook when funds arrive in proxy member wallet
CREATE OR REPLACE FUNCTION public.process_proxy_deposit(
  p_user_id            UUID,
  p_proxy_member_id    TEXT,
  p_amount_usdc_micro  BIGINT,
  p_reference          TEXT DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_result JSON;
  v_tx_id UUID;
BEGIN
  -- Service-role or webhook can call this (no auth check for webhooks)
  IF auth.uid() IS NOT NULL AND auth.uid() != p_user_id THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  -- Validate amount
  IF p_amount_usdc_micro <= 0 THEN
    RAISE EXCEPTION 'Amount must be positive';
  END IF;

  -- Step 1: Credit user's wallet with the deposit
  UPDATE public.wallets
  SET usdc_balance_micro = usdc_balance_micro + p_amount_usdc_micro
  WHERE user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'user not found';
  END IF;

  -- Step 2: Allocate 90% to cNGN yield pool
  PERFORM public.allocate_cngn_pool(p_user_id, p_amount_usdc_micro);

  -- Step 3: Record transaction
  INSERT INTO public.transactions (
    user_id,
    type,
    direction,
    amount_usdc_micro,
    description,
    status,
    reference
  ) VALUES (
    p_user_id,
    'deposit',
    'credit',
    p_amount_usdc_micro,
    'Proxy deposit from ' || p_proxy_member_id,
    'completed',
    p_reference
  ) RETURNING id INTO v_tx_id;

  -- Step 4: Log the proxy deposit event
  INSERT INTO public.proxy_transfers (
    proxy_member_id,
    action,
    amount_usdc_micro,
    description
  ) VALUES (
    p_proxy_member_id,
    'AUTO_CREDIT',
    p_amount_usdc_micro,
    'Automatic proxy deposit routing to user'
  );

  v_result := JSON_BUILD_OBJECT(
    'status', 'credited',
    'user_id', p_user_id,
    'amount_usdc_micro', p_amount_usdc_micro,
    'transaction_id', v_tx_id,
    'allocated_to_pool', (p_amount_usdc_micro * 90 / 100)::bigint
  );

  RETURN v_result;
END;
$$;

-- Extend proxy_transfers table to support AUTO_CREDIT action
ALTER TABLE public.proxy_transfers
DROP CONSTRAINT IF EXISTS proxy_transfers_action_check;

ALTER TABLE public.proxy_transfers
ADD CONSTRAINT proxy_transfers_action_check 
CHECK (action IN ('CREDIT', 'DEBIT', 'AUTO_CREDIT'));

-- Optional: add index for faster lookups by proxy member
CREATE INDEX IF NOT EXISTS idx_proxy_transfers_member ON public.proxy_transfers(proxy_member_id);
CREATE INDEX IF NOT EXISTS idx_proxy_transfers_action ON public.proxy_transfers(action);
