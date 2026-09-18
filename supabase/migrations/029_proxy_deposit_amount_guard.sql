-- 029_proxy_deposit_amount_guard.sql
-- V2-MED-02 — bound the amount accepted by process_proxy_deposit.
--
-- This RPC is reachable from the (unsigned) Flipeet webhook and the Xend webhook
-- via auto-routing. The only check today is `> 0`, so a malformed or forged
-- callback that slips past the token check could credit an arbitrarily large
-- balance. Add an upper bound (and a sane floor) so a bad amount is rejected
-- loudly instead of minting a huge balance. The cap is read from
-- platform_settings('max_proxy_deposit_micro') so ops can tune it without a
-- migration; default ₦100,000,000 (1e14 micro).
-- Idempotent: CREATE OR REPLACE.

INSERT INTO public.platform_settings (key, value) VALUES
  ('max_proxy_deposit_micro', '100000000000000')  -- ₦100,000,000 in cNGN micro
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.process_proxy_deposit(
  p_user_id            UUID,
  p_proxy_member_id    TEXT,
  p_amount_usdc_micro  BIGINT,
  p_reference          TEXT DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_result   JSON;
  v_tx_id    UUID;
  v_max      BIGINT;
  v_min      CONSTANT BIGINT := 1000000; -- 1 cNGN floor (ignore dust/zero callbacks)
BEGIN
  -- Service-role or webhook can call this (no auth check for webhooks)
  IF auth.uid() IS NOT NULL AND auth.uid() != p_user_id THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  -- V2-MED-02: bound the amount. Floor rejects zero/dust; cap rejects implausible
  -- (likely malformed/forged) amounts before they ever touch a balance.
  IF p_amount_usdc_micro < v_min THEN
    RAISE EXCEPTION 'Amount below minimum (% micro)', v_min;
  END IF;

  SELECT COALESCE(NULLIF(value, '')::BIGINT, 100000000000000)
    INTO v_max
    FROM public.platform_settings
   WHERE key = 'max_proxy_deposit_micro';
  IF v_max IS NULL THEN
    v_max := 100000000000000; -- ₦100,000,000 default if the setting row is missing
  END IF;

  IF p_amount_usdc_micro > v_max THEN
    RAISE EXCEPTION 'Amount exceeds maximum (% micro)', v_max;
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
    user_id, type, direction, amount_usdc_micro, description, status, reference
  ) VALUES (
    p_user_id, 'deposit', 'credit', p_amount_usdc_micro,
    'Proxy deposit from ' || p_proxy_member_id, 'completed', p_reference
  ) RETURNING id INTO v_tx_id;

  -- Step 4: Log the proxy deposit event
  INSERT INTO public.proxy_transfers (
    proxy_member_id, action, amount_usdc_micro, description
  ) VALUES (
    p_proxy_member_id, 'AUTO_CREDIT', p_amount_usdc_micro,
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