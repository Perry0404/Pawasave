-- 106_goal_completion_principal_only.sql  (run after 105)
--
-- Completing a savings goal pays back principal. It used to pay principal plus 33% a year of
-- interest that nothing funds.
--
-- `complete_savings_goal` credited `saved_usdc_micro * 0.33 * days/365` and added it to the wallet.
-- Migration 071 removed the phantom *naira* credit from this same function and left a note about the
-- rest, which is worth quoting because it is the whole justification for this migration:
--
--   "NOTE (separate, flagged not fixed here): complete_savings_goal still credits 33% 'interest'
--    that is projected/unfunded — that's phantom cNGN. Leave the advertised return for now but move
--    it to real yield (Meristem) or make it principal-only."
--
-- This takes the second option. Nothing accrues yield to a goal: there is no schedule, no position,
-- no spread — the 33% was a number in a formula. Every completed goal minted that much cNGN against
-- no asset.
--
-- WHY NOW. The app is about to expose completion, and it has to: completion is how somebody gets
-- their money out when they hit the target. The alternative is making them *break* a goal they
-- finished and pay the 0.5% early fee for succeeding, which is worse for them and still leaves the
-- mint in place for whoever calls the function next.
--
-- WHAT A USER SEES. Hitting the target is still the better outcome than giving up on one — principal
-- in full, against principal less 0.5% for breaking early. It is no longer a return, and the app does
-- not claim one (spec R2.5).
--
-- interest_earned_micro is still written, as zero, so the column keeps meaning "what this goal paid in
-- interest" rather than becoming stale at whatever the last phantom figure was.
--
-- REVERSIBLE. When there is real yield behind a goal, the credit comes back as a figure read from
-- wherever that yield is accounted, not as a rate multiplied by elapsed days.

CREATE OR REPLACE FUNCTION public.complete_savings_goal(p_goal_id UUID, p_user_id UUID)
RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_goal public.savings_goals%ROWTYPE;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() != p_user_id THEN RAISE EXCEPTION 'unauthorized'; END IF;
  SELECT * INTO v_goal FROM public.savings_goals WHERE id = p_goal_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'goal not found'; END IF;
  IF v_goal.status != 'active' THEN RAISE EXCEPTION 'goal is not active'; END IF;
  IF v_goal.saved_usdc_micro < v_goal.target_usdc_micro THEN RAISE EXCEPTION 'target not yet reached'; END IF;

  -- Principal, in full. No fee for finishing, and no interest, because none was ever earned.
  UPDATE public.wallets
  SET usdc_balance_micro = usdc_balance_micro + v_goal.saved_usdc_micro, updated_at = now()
  WHERE user_id = p_user_id;

  UPDATE public.savings_goals
  SET status = 'completed', interest_earned_micro = 0, completed_at = NOW()
  WHERE id = p_goal_id;

  -- The ledger row the old body never wrote. Without it, money appearing in a wallet on completion
  -- had no transaction behind it, which is exactly the reconciliation gap 080 complains about.
  INSERT INTO public.transactions
    (user_id, type, direction, amount_kobo, amount_usdc_micro, description, status)
  VALUES
    (p_user_id, 'goal_claim', 'credit', v_goal.saved_naira_kobo, v_goal.saved_usdc_micro,
     format('Goal "%s" reached — principal returned', v_goal.title), 'completed');

  -- Still returns the interest paid, so callers reading it see zero rather than a stale figure.
  RETURN 0;
END;
$$;

GRANT EXECUTE ON FUNCTION public.complete_savings_goal(UUID, UUID) TO authenticated, service_role;

COMMENT ON FUNCTION public.complete_savings_goal(UUID, UUID) IS
  'Returns a reached goal''s principal to spendable balance. Pays NO interest: the 33% a year this '
  'used to credit was unfunded, as 071''s header recorded. See 106.';
