-- 071_unify_goals_emergency_cngn.sql  (run after 070)
--
-- Stop the remaining phantom-Naira mints. Goals and emergency payouts still credited the
-- legacy naira_balance_kobo ON TOP of the real cNGN, double-crediting unbacked money:
--   • complete_savings_goal (012) + break_savings_goal (043): returned cNGN (real) AND
--     credited saved_naira_kobo (phantom). contribute_to_goal only ever debited cNGN
--     (usdc_balance_micro), so the naira credit was never backed.
--   • cast_emergency_vote (017): paid the emergency pot out to naira_balance_kobo.
-- Fix: all three credit cNGN only (usdc_balance_micro, 1 NGN = 1 cNGN → ×10000 from kobo).
-- After this + 070, NOTHING credits naira_balance_kobo — the legacy field is dead (clear
-- any residual with the phantom-clear UPDATE). Idempotent (CREATE OR REPLACE).
--
-- NOTE (separate, flagged not fixed here): complete_savings_goal still credits 33% "interest"
-- that is projected/unfunded — that's phantom cNGN. Leave the advertised return for now but
-- move it to real yield (Meristem) or make it principal-only. Also: esusu_contributions has
-- no unique (group,member,cycle) guard, so a double-tap inflates the pot (seen live: one
-- member recorded cycle-1 five times) — add a guard/dedup next.

-- ── goal completion — credit cNGN only ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.complete_savings_goal(p_goal_id UUID, p_user_id UUID)
RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_goal public.savings_goals%ROWTYPE;
  v_days NUMERIC; v_interest BIGINT; v_total BIGINT;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() != p_user_id THEN RAISE EXCEPTION 'unauthorized'; END IF;
  SELECT * INTO v_goal FROM public.savings_goals WHERE id = p_goal_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'goal not found'; END IF;
  IF v_goal.status != 'active' THEN RAISE EXCEPTION 'goal is not active'; END IF;
  IF v_goal.saved_usdc_micro < v_goal.target_usdc_micro THEN RAISE EXCEPTION 'target not yet reached'; END IF;

  v_days     := GREATEST(1, EXTRACT(EPOCH FROM (NOW() - v_goal.started_at)) / 86400.0);
  v_interest := FLOOR(v_goal.saved_usdc_micro * 0.33 * (v_days / 365.0));
  v_total    := v_goal.saved_usdc_micro + v_interest;

  -- cNGN only. (Removed the phantom `naira_balance_kobo += saved_naira_kobo` double-credit.)
  UPDATE public.wallets
  SET usdc_balance_micro = usdc_balance_micro + v_total, updated_at = now()
  WHERE user_id = p_user_id;

  UPDATE public.savings_goals
  SET status = 'completed', interest_earned_micro = v_interest, completed_at = NOW()
  WHERE id = p_goal_id;

  RETURN v_interest;
END;
$$;
GRANT EXECUTE ON FUNCTION public.complete_savings_goal(UUID, UUID) TO authenticated, service_role;

-- ── goal early break — credit cNGN only (principal − fee), interest forfeited ────
CREATE OR REPLACE FUNCTION public.break_savings_goal(p_goal_id UUID, p_user_id UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
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

  -- cNGN only (principal minus the breaking fee). Interest forfeited. No phantom naira.
  UPDATE public.wallets
  SET usdc_balance_micro = usdc_balance_micro + (v_goal.saved_usdc_micro - v_fee_micro), updated_at = now()
  WHERE user_id = p_user_id;

  IF v_fee_kobo > 0 THEN
    INSERT INTO public.platform_fees (user_id, transaction_ref, fee_type, gross_amount_kobo, fee_amount_kobo, fee_percent)
    VALUES (p_user_id, 'goal_break_' || p_goal_id, 'goal_break_penalty', v_goal.saved_naira_kobo, v_fee_kobo, v_fee_pct);
    UPDATE public.platform_settings SET value = (COALESCE(value::bigint, 0) + v_fee_kobo)::text WHERE key = 'platform_revenue_kobo';
  END IF;

  INSERT INTO public.transactions (user_id, type, direction, amount_kobo, amount_usdc_micro, description, status)
  VALUES (p_user_id, 'goal_claim', 'credit', v_goal.saved_naira_kobo - v_fee_kobo, v_goal.saved_usdc_micro - v_fee_micro,
          format('Goal "%s" broken early — %s%% breaking fee, interest forfeited', v_goal.title, v_fee_pct), 'completed');

  UPDATE public.savings_goals SET status = 'broken', interest_earned_micro = 0, completed_at = now() WHERE id = p_goal_id;
  RETURN TRUE;
END;
$$;
GRANT EXECUTE ON FUNCTION public.break_savings_goal(UUID, UUID) TO authenticated, service_role;

-- ── emergency payout — disburse the emergency pot in cNGN ────────────────────────
CREATE OR REPLACE FUNCTION public.cast_emergency_vote(p_request_id uuid, p_approve boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_request       public.emergency_requests%rowtype;
  v_group         public.esusu_groups%rowtype;
  v_member_count  int;
  v_approve_count int;
  v_total_votes   int;
BEGIN
  SELECT * INTO v_request FROM public.emergency_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'Request not found'); END IF;
  IF v_request.status <> 'voting' THEN RETURN jsonb_build_object('ok', false, 'error', 'This vote is already closed'); END IF;

  IF NOT EXISTS (SELECT 1 FROM public.esusu_members WHERE group_id = v_request.group_id AND user_id = auth.uid()) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Not a member of this group');
  END IF;
  IF EXISTS (SELECT 1 FROM public.emergency_votes WHERE request_id = p_request_id AND voter_id = auth.uid()) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'You have already voted');
  END IF;

  INSERT INTO public.emergency_votes (request_id, voter_id, approve) VALUES (p_request_id, auth.uid(), p_approve);

  SELECT COUNT(*) INTO v_member_count  FROM public.esusu_members WHERE group_id = v_request.group_id;
  SELECT COUNT(*) INTO v_approve_count FROM public.emergency_votes WHERE request_id = p_request_id AND approve = true;
  SELECT COUNT(*) INTO v_total_votes   FROM public.emergency_votes WHERE request_id = p_request_id;

  IF v_approve_count > v_member_count / 2 THEN
    SELECT * INTO v_group FROM public.esusu_groups WHERE id = v_request.group_id FOR UPDATE;
    IF v_group.emergency_pot_kobo < v_request.amount_kobo THEN
      RETURN jsonb_build_object('ok', false, 'error', 'Emergency pot is now insufficient');
    END IF;

    UPDATE public.esusu_groups SET emergency_pot_kobo = emergency_pot_kobo - v_request.amount_kobo WHERE id = v_request.group_id;

    -- Credit requester in cNGN (was naira_balance_kobo — phantom). 1 NGN = 1 cNGN.
    UPDATE public.wallets
    SET usdc_balance_micro = usdc_balance_micro + (v_request.amount_kobo * 10000), updated_at = now()
    WHERE user_id = v_request.requester_id;

    INSERT INTO public.transactions (user_id, type, direction, amount_kobo, amount_usdc_micro, description)
    VALUES (v_request.requester_id, 'emergency_payout', 'credit', v_request.amount_kobo, (v_request.amount_kobo * 10000),
            'Emergency payout from "' || v_group.name || '"');

    UPDATE public.emergency_requests SET status = 'disbursed' WHERE id = p_request_id;
    RETURN jsonb_build_object('ok', true, 'disbursed', true, 'amount_kobo', v_request.amount_kobo);
  END IF;

  IF v_total_votes >= v_member_count THEN
    UPDATE public.emergency_requests SET status = 'rejected' WHERE id = p_request_id;
    RETURN jsonb_build_object('ok', true, 'disbursed', false, 'rejected', true);
  END IF;

  RETURN jsonb_build_object('ok', true, 'disbursed', false, 'approve_count', v_approve_count, 'total_votes', v_total_votes, 'member_count', v_member_count);
END;
$$;
GRANT EXECUTE ON FUNCTION public.cast_emergency_vote(uuid, boolean) TO authenticated;
