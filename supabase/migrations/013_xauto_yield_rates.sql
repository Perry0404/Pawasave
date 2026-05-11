-- ============================================================
-- Migration 013: Update savings goals RPCs to 50% APY (XEND X Auto)
-- Fixed savings locks and savings goals now earn 50% APY (users)
-- Platform keeps 6% from X Auto's 56% APY as revenue.
-- Flexible vault and esusu remain on 33% APY (XEND Money Market).
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- PART A: Update complete_savings_goal to 50% APY
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.complete_savings_goal(p_goal_id uuid)
RETURNS jsonb AS $$
DECLARE
  v_goal     record;
  v_days     numeric;
  v_interest bigint;
BEGIN
  -- Ownership + status check
  SELECT * INTO v_goal FROM public.savings_goals WHERE id = p_goal_id AND user_id = auth.uid() AND status = 'active';
  IF NOT FOUND THEN RAISE EXCEPTION 'Goal not found or not active'; END IF;

  -- Must have reached the target
  IF v_goal.saved_usdc_micro < v_goal.target_usdc_micro THEN RAISE EXCEPTION 'Target not yet reached'; END IF;

  v_days := GREATEST(EXTRACT(EPOCH FROM (now() - v_goal.created_at)) / 86400.0, 0);

  -- 50% APY (X Auto) — user share of XEND X Auto 56% product
  v_interest := FLOOR(v_goal.saved_usdc_micro * 0.50 * (v_days / 365.0));

  -- Credit principal + interest back to usdc balance
  UPDATE public.wallets
  SET usdc_balance_micro = usdc_balance_micro + v_goal.saved_usdc_micro + v_interest,
      updated_at = now()
  WHERE user_id = v_goal.user_id;

  -- Mark goal completed
  UPDATE public.savings_goals
  SET status = 'completed', interest_earned_micro = v_interest, completed_at = now()
  WHERE id = p_goal_id;

  -- Audit transaction
  INSERT INTO public.transactions (user_id, type, direction, amount_kobo, amount_usdc_micro, description, status)
  VALUES (v_goal.user_id, 'goal_claim', 'credit', 0, v_goal.saved_usdc_micro + v_interest,
          format('Goal "%s" completed — principal + %.0f USDC interest (50%% APY, X Auto)', v_goal.title, v_interest / 1000000.0),
          'completed');

  RETURN jsonb_build_object('interest_micro', v_interest, 'total_micro', v_goal.saved_usdc_micro + v_interest);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.complete_savings_goal(uuid) TO authenticated;

-- ────────────────────────────────────────────────────────────
-- PART B: Update break_savings_goal to 50% APY (forfeited to platform)
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.break_savings_goal(p_goal_id uuid)
RETURNS jsonb AS $$
DECLARE
  v_goal       record;
  v_days       numeric;
  v_interest   bigint;
  v_rev_before bigint;
BEGIN
  -- Ownership + status check
  SELECT * INTO v_goal FROM public.savings_goals WHERE id = p_goal_id AND user_id = auth.uid() AND status = 'active';
  IF NOT FOUND THEN RAISE EXCEPTION 'Goal not found or not active'; END IF;

  v_days := GREATEST(EXTRACT(EPOCH FROM (now() - v_goal.created_at)) / 86400.0, 0);

  -- Calculate how much interest had accrued at 50% APY — this becomes platform revenue
  v_interest := FLOOR(v_goal.saved_usdc_micro * 0.50 * (v_days / 365.0));

  -- Return principal only (interest forfeited)
  UPDATE public.wallets
  SET usdc_balance_micro = usdc_balance_micro + v_goal.saved_usdc_micro,
      updated_at = now()
  WHERE user_id = v_goal.user_id;

  -- Mark goal broken
  UPDATE public.savings_goals
  SET status = 'broken', interest_earned_micro = 0, completed_at = now()
  WHERE id = p_goal_id;

  -- Capture forfeited interest as platform revenue
  SELECT COALESCE(value::bigint, 0) INTO v_rev_before FROM public.platform_settings WHERE key = 'platform_revenue_kobo';
  UPDATE public.platform_settings SET value = (v_rev_before + v_interest)::text WHERE key = 'platform_revenue_kobo';

  -- Record forfeited interest in platform_fees table
  INSERT INTO public.platform_fees (user_id, fee_type, amount_usdc_micro, description)
  VALUES (v_goal.user_id, 'goal_break', v_interest,
          format('Goal "%s" broken early — forfeited %.0f USDC interest (50%% APY, X Auto)', v_goal.title, v_interest / 1000000.0));

  -- Audit transaction (principal return only)
  INSERT INTO public.transactions (user_id, type, direction, amount_kobo, amount_usdc_micro, description, status)
  VALUES (v_goal.user_id, 'goal_contribute', 'credit', 0, v_goal.saved_usdc_micro,
          format('Goal "%s" broken — principal returned, interest forfeited', v_goal.title),
          'completed');

  RETURN jsonb_build_object('returned_micro', v_goal.saved_usdc_micro, 'forfeited_interest_micro', v_interest);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.break_savings_goal(uuid) TO authenticated;

-- ────────────────────────────────────────────────────────────
-- PART C: Update platform_settings to document yield rates
-- ────────────────────────────────────────────────────────────
INSERT INTO public.platform_settings (key, value)
VALUES
  ('xauto_product_apy_percent', '56'),
  ('xauto_user_apy_percent', '50'),
  ('xauto_platform_spread_percent', '6'),
  ('mm_user_apy_percent', '33')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
