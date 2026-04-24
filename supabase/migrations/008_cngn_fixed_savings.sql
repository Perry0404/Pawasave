-- ============================================================
-- Migration 008: Fixed Savings on cNGN Pool
--
-- Changes:
--   1. lock_savings now locks from cngn_pool_micro instead of
--      free usdc_balance_micro
--   2. withdraw_lock returns funds to cngn_pool_micro
--   3. early withdrawal penalties also increment platform_revenue_kobo
-- ============================================================

CREATE OR REPLACE FUNCTION public.lock_savings(
  p_user_id uuid,
  p_usdc_micro bigint,
  p_kobo bigint,
  p_duration_days int,
  p_apy numeric
) RETURNS uuid AS $$
DECLARE
  w public.wallets%rowtype;
  v_projected bigint;
  v_lock_id uuid;
BEGIN
  SELECT * INTO w FROM public.wallets WHERE user_id = p_user_id FOR UPDATE;

  IF w.cngn_pool_micro < p_usdc_micro THEN
    RAISE EXCEPTION 'Insufficient cNGN balance';
  END IF;

  v_projected := floor(p_usdc_micro::numeric * (p_apy / 100.0) * (p_duration_days::numeric / 365.0));

  UPDATE public.wallets
  SET cngn_pool_micro = cngn_pool_micro - p_usdc_micro,
      updated_at = now()
  WHERE user_id = p_user_id;

  INSERT INTO public.savings_locks (
    user_id, amount_usdc_micro, amount_kobo, apy_percent, duration_days,
    projected_interest_micro, unlocks_at
  ) VALUES (
    p_user_id, p_usdc_micro, p_kobo, p_apy, p_duration_days,
    v_projected, now() + (p_duration_days || ' days')::interval
  ) RETURNING id INTO v_lock_id;

  INSERT INTO public.transactions (
    user_id, type, direction, amount_kobo, amount_usdc_micro,
    description, status
  ) VALUES (
    p_user_id, 'save_to_vault', 'debit', p_kobo, p_usdc_micro,
    'Locked cNGN savings for ' || p_duration_days || ' days at ' || p_apy || '% APY',
    'completed'
  );

  RETURN v_lock_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.withdraw_lock(
  p_user_id uuid,
  p_lock_id uuid,
  p_early boolean DEFAULT false
) RETURNS boolean AS $$
DECLARE
  v_lock public.savings_locks%rowtype;
  v_payout bigint;
  v_penalty_kobo bigint := 0;
BEGIN
  SELECT * INTO v_lock FROM public.savings_locks
  WHERE id = p_lock_id AND user_id = p_user_id AND status = 'active'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF p_early AND now() < v_lock.unlocks_at THEN
    v_payout := v_lock.amount_usdc_micro;
    v_penalty_kobo := floor(v_lock.amount_kobo * 0.005);

    UPDATE public.savings_locks
    SET status = 'early_withdrawn', withdrawn_at = now()
    WHERE id = p_lock_id;

    IF v_penalty_kobo > 0 THEN
      INSERT INTO public.platform_fees (
        user_id, transaction_ref, fee_type, gross_amount_kobo, fee_amount_kobo, fee_percent
      ) VALUES (
        p_user_id, p_lock_id::text, 'vault_lock_penalty', v_lock.amount_kobo, v_penalty_kobo, 0.50
      );

      UPDATE public.platform_settings
      SET value = (COALESCE(value::bigint, 0) + v_penalty_kobo)::text
      WHERE key = 'platform_revenue_kobo';
    END IF;
  ELSE
    v_payout := v_lock.amount_usdc_micro + v_lock.projected_interest_micro;

    UPDATE public.savings_locks
    SET status = 'withdrawn', matured_at = now(), withdrawn_at = now()
    WHERE id = p_lock_id;
  END IF;

  UPDATE public.wallets
  SET cngn_pool_micro = cngn_pool_micro + v_payout,
      updated_at = now()
  WHERE user_id = p_user_id;

  INSERT INTO public.transactions (
    user_id, type, direction, amount_kobo, amount_usdc_micro,
    description, status
  ) VALUES (
    p_user_id, 'vault_withdraw', 'credit',
    v_lock.amount_kobo,
    v_payout,
    CASE WHEN p_early
      THEN 'Early cNGN lock withdrawal (no interest)'
      ELSE 'Matured cNGN lock withdrawn + ' || v_lock.projected_interest_micro || ' μUSDC interest'
    END,
    'completed'
  );

  RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
