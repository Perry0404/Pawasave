-- ============================================================
-- Migration 017: Emergency vote RPC functions
--
-- Implements the two-step emergency payout flow for Esusu circles:
--   1. request_emergency_payout  — any member opens an emergency request
--   2. cast_emergency_vote       — any member casts an approve/reject vote;
--      automatically disburses on simple majority (>50% approve) or
--      rejects when every member has voted and majority said no.
--
-- Tables already exist from migration 001:
--   emergency_requests (id, group_id, requester_id, reason, amount_kobo, status)
--   emergency_votes    (id, request_id, voter_id, approve, voted_at)
-- Emergency pot funded: 5% of every contribution (migration 002).
-- ============================================================

-- ── request_emergency_payout ────────────────────────────────────────────────
-- Any group member may open one emergency request at a time per group.
-- Amount is validated against the current emergency_pot_kobo.
CREATE OR REPLACE FUNCTION public.request_emergency_payout(
  p_group_id    uuid,
  p_reason      text,
  p_amount_kobo bigint
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_group      public.esusu_groups%rowtype;
  v_request_id uuid;
BEGIN
  -- Caller must be a member of this group
  IF NOT EXISTS (
    SELECT 1 FROM public.esusu_members
    WHERE group_id = p_group_id AND user_id = auth.uid()
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Not a member of this group');
  END IF;

  -- Lock and fetch group
  SELECT * INTO v_group
  FROM public.esusu_groups
  WHERE id = p_group_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Group not found');
  END IF;

  IF p_amount_kobo <= 0 OR p_amount_kobo > v_group.emergency_pot_kobo THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', format(
        'Amount must be between ₦1 and the emergency pot (₦%s)',
        (v_group.emergency_pot_kobo / 100)::text
      )
    );
  END IF;

  -- Only one active vote per group at a time
  IF EXISTS (
    SELECT 1 FROM public.emergency_requests
    WHERE group_id = p_group_id AND status = 'voting'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'A vote is already in progress for this group');
  END IF;

  INSERT INTO public.emergency_requests (group_id, requester_id, reason, amount_kobo)
  VALUES (p_group_id, auth.uid(), p_reason, p_amount_kobo)
  RETURNING id INTO v_request_id;

  RETURN jsonb_build_object('ok', true, 'request_id', v_request_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.request_emergency_payout(uuid, text, bigint) TO authenticated;


-- ── cast_emergency_vote ─────────────────────────────────────────────────────
-- Any group member casts one approve or reject vote on an open request.
-- After each vote the function re-tallies:
--   • Simple majority (approve_count > member_count / 2) → disburse immediately
--   • All members voted with no majority → reject
-- The disburse path: debits emergency_pot_kobo, credits requester's naira_balance_kobo,
-- records an emergency_payout transaction, and marks the request 'disbursed'.
CREATE OR REPLACE FUNCTION public.cast_emergency_vote(
  p_request_id uuid,
  p_approve    boolean
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_request       public.emergency_requests%rowtype;
  v_group         public.esusu_groups%rowtype;
  v_member_count  int;
  v_approve_count int;
  v_total_votes   int;
BEGIN
  -- Lock the request row
  SELECT * INTO v_request
  FROM public.emergency_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Request not found');
  END IF;

  IF v_request.status <> 'voting' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'This vote is already closed');
  END IF;

  -- Caller must be a member
  IF NOT EXISTS (
    SELECT 1 FROM public.esusu_members
    WHERE group_id = v_request.group_id AND user_id = auth.uid()
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Not a member of this group');
  END IF;

  -- One vote per member
  IF EXISTS (
    SELECT 1 FROM public.emergency_votes
    WHERE request_id = p_request_id AND voter_id = auth.uid()
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'You have already voted');
  END IF;

  -- Record the vote
  INSERT INTO public.emergency_votes (request_id, voter_id, approve)
  VALUES (p_request_id, auth.uid(), p_approve);

  -- Re-tally
  SELECT COUNT(*) INTO v_member_count
  FROM public.esusu_members
  WHERE group_id = v_request.group_id;

  SELECT COUNT(*) INTO v_approve_count
  FROM public.emergency_votes
  WHERE request_id = p_request_id AND approve = true;

  SELECT COUNT(*) INTO v_total_votes
  FROM public.emergency_votes
  WHERE request_id = p_request_id;

  -- Simple majority → disburse
  IF v_approve_count > v_member_count / 2 THEN
    SELECT * INTO v_group
    FROM public.esusu_groups
    WHERE id = v_request.group_id
    FOR UPDATE;

    -- Guard: pot may have shrunk since request was created
    IF v_group.emergency_pot_kobo < v_request.amount_kobo THEN
      RETURN jsonb_build_object('ok', false, 'error', 'Emergency pot is now insufficient');
    END IF;

    -- Debit emergency pot
    UPDATE public.esusu_groups
    SET emergency_pot_kobo = emergency_pot_kobo - v_request.amount_kobo
    WHERE id = v_request.group_id;

    -- Credit requester's naira balance
    UPDATE public.wallets
    SET naira_balance_kobo = naira_balance_kobo + v_request.amount_kobo,
        updated_at         = now()
    WHERE user_id = v_request.requester_id;

    -- Transaction record
    INSERT INTO public.transactions (user_id, type, direction, amount_kobo, description)
    VALUES (
      v_request.requester_id,
      'emergency_payout',
      'credit',
      v_request.amount_kobo,
      'Emergency payout from "' || v_group.name || '"'
    );

    -- Close request
    UPDATE public.emergency_requests
    SET status = 'disbursed'
    WHERE id = p_request_id;

    RETURN jsonb_build_object(
      'ok',         true,
      'disbursed',  true,
      'amount_kobo', v_request.amount_kobo
    );
  END IF;

  -- All members voted but no majority → reject
  IF v_total_votes >= v_member_count THEN
    UPDATE public.emergency_requests
    SET status = 'rejected'
    WHERE id = p_request_id;

    RETURN jsonb_build_object('ok', true, 'disbursed', false, 'rejected', true);
  END IF;

  -- Vote recorded, awaiting more votes
  RETURN jsonb_build_object(
    'ok',           true,
    'disbursed',    false,
    'approve_count', v_approve_count,
    'total_votes',  v_total_votes,
    'member_count', v_member_count
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.cast_emergency_vote(uuid, boolean) TO authenticated;
