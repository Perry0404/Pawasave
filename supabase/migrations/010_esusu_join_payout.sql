-- ============================================================
-- Migration 010: Esusu Circle Invite Join + Sequential Payout
--
-- 1. Public-safe read policy so anyone (anon API) can see
--    a group by ID for the invite link / join page.
-- 2. join_esusu_group  — safe join RPC:
--    checks capacity, duplicate, inserts at next position,
--    transitions group status forming → active when full.
-- 3. process_esusu_payout — cycle completion RPC:
--    checks all members contributed, credits recipient,
--    advances current_cycle, marks completed when done.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- PART A: Allow any authenticated user to SELECT a group
--         (needed for the join page to show group info to
--          a non-member who received an invite link)
-- ────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Authenticated read any group" ON public.esusu_groups;
CREATE POLICY "Authenticated read any group" ON public.esusu_groups
  FOR SELECT USING (auth.uid() IS NOT NULL);

-- Allow unauthenticated service-role reads (API route already bypasses RLS
-- via service key; no additional policy needed for service role).


-- ────────────────────────────────────────────────────────────
-- PART B: join_esusu_group RPC
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.join_esusu_group(
  p_group_id uuid,
  p_user_id  uuid
) RETURNS jsonb AS $$
DECLARE
  v_group          public.esusu_groups%rowtype;
  v_member_count   int;
  v_next_position  int;
BEGIN
  -- Ownership check: authenticated callers can only join as themselves
  IF auth.uid() IS NOT NULL AND auth.uid() != p_user_id THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  -- Lock the group row
  SELECT * INTO v_group
  FROM public.esusu_groups
  WHERE id = p_group_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Circle not found');
  END IF;

  IF v_group.status = 'completed' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Circle is already completed');
  END IF;

  -- Already a member?
  IF EXISTS (
    SELECT 1 FROM public.esusu_members
    WHERE group_id = p_group_id AND user_id = p_user_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'You are already a member of this circle');
  END IF;

  -- Count existing members
  SELECT COUNT(*) INTO v_member_count
  FROM public.esusu_members
  WHERE group_id = p_group_id;

  IF v_member_count >= v_group.max_members THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Circle is full');
  END IF;

  v_next_position := v_member_count + 1;

  -- Insert the new member
  INSERT INTO public.esusu_members (group_id, user_id, payout_position)
  VALUES (p_group_id, p_user_id, v_next_position);

  -- Transition forming → active when the last spot is filled
  IF v_next_position = v_group.max_members THEN
    UPDATE public.esusu_groups
    SET status       = 'active',
        current_cycle = 1
    WHERE id = p_group_id;
  END IF;

  RETURN jsonb_build_object(
    'ok',       true,
    'position', v_next_position,
    'is_full',  (v_next_position = v_group.max_members)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.join_esusu_group(uuid, uuid) TO authenticated;


-- ────────────────────────────────────────────────────────────
-- PART C: process_esusu_payout RPC
--
-- Called after every contribution. Checks whether all members
-- have contributed for the current cycle. If yes:
--   • Credits the recipient's naira balance (pot_balance_kobo)
--   • Inserts an esusu_payout transaction record
--   • Resets pot_balance_kobo to 0
--   • Advances current_cycle (or marks completed)
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.process_esusu_payout(
  p_group_id uuid
) RETURNS jsonb AS $$
DECLARE
  v_group          public.esusu_groups%rowtype;
  v_member_count   int;
  v_contrib_count  int;
  v_recipient      public.esusu_members%rowtype;
  v_payout_kobo    bigint;
  v_payout_pos     int;
  v_next_cycle     int;
BEGIN
  -- Lock the group row
  SELECT * INTO v_group
  FROM public.esusu_groups
  WHERE id = p_group_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  IF v_group.status != 'active' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_active');
  END IF;

  -- Total members
  SELECT COUNT(*) INTO v_member_count
  FROM public.esusu_members
  WHERE group_id = p_group_id;

  -- Contributions recorded for this cycle
  SELECT COUNT(DISTINCT ec.member_id) INTO v_contrib_count
  FROM public.esusu_contributions ec
  JOIN public.esusu_members em ON ec.member_id = em.id
  WHERE ec.group_id = p_group_id
    AND ec.cycle_number = v_group.current_cycle;

  -- Not everyone has contributed yet
  IF v_contrib_count < v_member_count THEN
    RETURN jsonb_build_object(
      'ok',         false,
      'reason',     'incomplete',
      'contributed', v_contrib_count,
      'needed',     v_member_count
    );
  END IF;

  -- Determine payout position for this cycle:
  -- cycle 1 → position 1, cycle 2 → position 2, …
  v_payout_pos := ((v_group.current_cycle - 1) % v_member_count) + 1;

  SELECT * INTO v_recipient
  FROM public.esusu_members
  WHERE group_id = p_group_id AND payout_position = v_payout_pos;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_recipient');
  END IF;

  v_payout_kobo := v_group.pot_balance_kobo;
  v_next_cycle  := v_group.current_cycle + 1;

  -- Credit recipient wallet
  UPDATE public.wallets
  SET naira_balance_kobo = naira_balance_kobo + v_payout_kobo,
      updated_at         = now()
  WHERE user_id = v_recipient.user_id;

  -- Record payout transaction
  INSERT INTO public.transactions (user_id, type, direction, amount_kobo, description)
  VALUES (
    v_recipient.user_id,
    'esusu_payout',
    'credit',
    v_payout_kobo,
    'Ajo payout – Cycle ' || v_group.current_cycle || ' of "' || v_group.name || '"'
  );

  -- Advance group state
  IF v_next_cycle > v_member_count THEN
    -- All members have received a payout → completed
    UPDATE public.esusu_groups
    SET pot_balance_kobo = 0,
        current_cycle   = v_next_cycle,
        status          = 'completed'
    WHERE id = p_group_id;
  ELSE
    UPDATE public.esusu_groups
    SET pot_balance_kobo = 0,
        current_cycle   = v_next_cycle
    WHERE id = p_group_id;
  END IF;

  RETURN jsonb_build_object(
    'ok',          true,
    'paid_to',     v_recipient.user_id,
    'amount_kobo', v_payout_kobo,
    'cycle',       v_group.current_cycle,
    'next_cycle',  v_next_cycle,
    'completed',   (v_next_cycle > v_member_count)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.process_esusu_payout(uuid) TO authenticated, service_role;
