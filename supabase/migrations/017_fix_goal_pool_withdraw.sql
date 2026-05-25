-- 017_fix_goal_pool_withdraw.sql
-- Fixes contribute_to_goal to pull from cNGN pool first (like contribute_to_esusu does)
-- Prevents "Insufficient balance" errors when most USDC is in yield pool after deposits

CREATE OR REPLACE FUNCTION public.contribute_to_goal(
  p_goal_id    UUID,
  p_user_id    UUID,
  p_naira_kobo BIGINT,
  p_usdc_micro BIGINT
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_wallet        public.wallets%ROWTYPE;
  v_goal_status   TEXT;
  v_from_pool     BIGINT;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() != p_user_id THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  -- Fetch goal
  SELECT status INTO v_goal_status
  FROM public.savings_goals
  WHERE id = p_goal_id AND user_id = p_user_id;

  IF NOT FOUND            THEN RAISE EXCEPTION 'goal not found'; END IF;
  IF v_goal_status != 'active' THEN RAISE EXCEPTION 'goal is not active'; END IF;

  -- Fetch wallet for balance checks
  SELECT * INTO v_wallet
  FROM public.wallets WHERE user_id = p_user_id FOR UPDATE;

  -- Check total available (free balance + pool)
  IF (v_wallet.usdc_balance_micro + v_wallet.cngn_pool_micro) < p_usdc_micro THEN
    RETURN FALSE;
  END IF;

  -- Step 1: Free pool funds into usdc_balance if needed
  v_from_pool := GREATEST(0, LEAST(v_wallet.cngn_pool_micro, p_usdc_micro - v_wallet.usdc_balance_micro));
  IF v_from_pool > 0 THEN
    UPDATE public.wallets
    SET cngn_pool_micro     = cngn_pool_micro - v_from_pool,
        usdc_balance_micro  = usdc_balance_micro + v_from_pool
    WHERE user_id = p_user_id;
  END IF;

  -- Step 2: Debit full amount from usdc_balance and naira balance
  UPDATE public.wallets
  SET usdc_balance_micro = usdc_balance_micro - p_usdc_micro,
      naira_balance_kobo = GREATEST(0, naira_balance_kobo - p_naira_kobo)
  WHERE user_id = p_user_id;

  -- Step 3: Credit the goal
  UPDATE public.savings_goals
  SET saved_usdc_micro    = saved_usdc_micro + p_usdc_micro,
      saved_naira_kobo    = saved_naira_kobo + p_naira_kobo,
      last_contributed_at = NOW()
  WHERE id = p_goal_id;

  RETURN TRUE;
END;
$$;
