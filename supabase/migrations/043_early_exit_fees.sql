-- 043_early_exit_fees.sql
-- Item 2: correct early-exit economics for SAVINGS GOALS.
--
-- break_savings_goal (012) had two anomalies:
--   (a) NO breaking fee — the user got 100% of principal back, so breaking early cost
--       nothing beyond the (already-forfeited) interest.
--   (b) it added v_interest, a value in USDC-MICRO, into platform_revenue_kobo, a KOBO
--       counter — inflating recorded revenue ~100x with money that never moved (goal
--       interest is projected, never funded, so there is no real interest pot to keep).
--
-- Fix: on an early break, CHARGE a breaking fee (a % of principal, actually deducted
-- and kept as real cNGN revenue) and return the remaining principal. Interest is
-- forfeited entirely (the user gets none) — the intended penalty. No phantom,
-- unit-mismatched interest revenue. Mirrors the fixed-deposit fix in 042 (withdraw_lock
-- now deducts its breaking fee too).

INSERT INTO public.platform_settings (key, value) VALUES
  ('goal_break_fee_percent', '0.5')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.break_savings_goal(
  p_goal_id UUID, p_user_id UUID
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_goal      public.savings_goals%ROWTYPE;
  v_fee_pct   numeric := COALESCE((SELECT value::numeric FROM public.platform_settings WHERE key = 'goal_break_fee_percent'), 0.5);
  v_fee_kobo  bigint;
  v_fee_micro bigint;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() != p_user_id THEN RAISE EXCEPTION 'unauthorized'; END IF;

  SELECT * INTO v_goal FROM public.savings_goals WHERE id = p_goal_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'goal not found'; END IF;
  IF v_goal.status != 'active' THEN RAISE EXCEPTION 'goal is not active'; END IF;

  v_fee_micro := FLOOR(v_goal.saved_usdc_micro * v_fee_pct / 100.0);
  v_fee_kobo  := FLOOR(v_goal.saved_naira_kobo * v_fee_pct / 100.0);

  -- Return principal MINUS the breaking fee. Interest is forfeited entirely.
  UPDATE public.wallets
  SET usdc_balance_micro = usdc_balance_micro + (v_goal.saved_usdc_micro - v_fee_micro),
      naira_balance_kobo  = naira_balance_kobo  + (v_goal.saved_naira_kobo - v_fee_kobo),
      updated_at = now()
  WHERE user_id = p_user_id;

  -- The breaking fee is REAL revenue: cNGN withheld from the returned principal. Kobo unit.
  IF v_fee_kobo > 0 THEN
    INSERT INTO public.platform_fees (user_id, transaction_ref, fee_type, gross_amount_kobo, fee_amount_kobo, fee_percent)
    VALUES (p_user_id, 'goal_break_' || p_goal_id, 'goal_break_penalty', v_goal.saved_naira_kobo, v_fee_kobo, v_fee_pct);
    UPDATE public.platform_settings
    SET value = (COALESCE(value::bigint, 0) + v_fee_kobo)::text WHERE key = 'platform_revenue_kobo';
  END IF;

  INSERT INTO public.transactions (user_id, type, direction, amount_kobo, amount_usdc_micro, description, status)
  VALUES (p_user_id, 'goal_claim', 'credit', v_goal.saved_naira_kobo - v_fee_kobo, v_goal.saved_usdc_micro - v_fee_micro,
          format('Goal "%s" broken early — %s%% breaking fee, interest forfeited', v_goal.title, v_fee_pct), 'completed');

  UPDATE public.savings_goals
  SET status = 'broken', interest_earned_micro = 0, completed_at = now()
  WHERE id = p_goal_id;

  RETURN TRUE;
END;
$$;

GRANT EXECUTE ON FUNCTION public.break_savings_goal(UUID, UUID) TO authenticated, service_role;