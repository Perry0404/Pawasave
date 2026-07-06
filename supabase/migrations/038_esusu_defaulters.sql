-- 038_esusu_defaulters.sql
-- Defaulter handling for Esusu/Ajo circles.
--
-- Before this, a single member who didn't contribute FROZE the whole circle:
-- process_esusu_payout blocks until every member has paid, and there was no
-- grace, penalty, auto-debit, or use of the 5% emergency pot (which just piled up
-- unused). This migration adds:
--   1. cycle_started_at   — when the current cycle opened (grace clock).
--   2. amount_owed_kobo    — what a member owes the emergency pot for a covered miss.
--   3. esusu_autodebit()   — cron RPC: auto-debits members who haven't paid after a
--      grace window; if their wallet is short, ADVANCES their share from the
--      emergency pot so the circle keeps moving, and records the debt.
--   4. clawback in process_esusu_payout — when a member with a debt reaches their
--      payout, the advance is deducted and repaid to the emergency pot (made whole).

-- ── 1. Schema ────────────────────────────────────────────────────────────────
ALTER TABLE public.esusu_groups
  ADD COLUMN IF NOT EXISTS cycle_started_at timestamptz;
ALTER TABLE public.esusu_members
  ADD COLUMN IF NOT EXISTS amount_owed_kobo bigint NOT NULL DEFAULT 0;

-- Backfill so existing active groups have a grace clock.
UPDATE public.esusu_groups
SET cycle_started_at = COALESCE(cycle_started_at, created_at, now())
WHERE status = 'active' AND cycle_started_at IS NULL;

-- ── 2. join_esusu_group — stamp cycle_started_at when the circle activates ────
CREATE OR REPLACE FUNCTION public.join_esusu_group(
  p_group_id uuid,
  p_user_id  uuid
) RETURNS jsonb AS $$
DECLARE
  v_group          public.esusu_groups%rowtype;
  v_member_count   int;
  v_next_position  int;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() != p_user_id THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT * INTO v_group FROM public.esusu_groups WHERE id = p_group_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Circle not found');
  END IF;
  IF v_group.status = 'completed' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Circle is already completed');
  END IF;
  IF EXISTS (SELECT 1 FROM public.esusu_members WHERE group_id = p_group_id AND user_id = p_user_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'You are already a member of this circle');
  END IF;

  SELECT COUNT(*) INTO v_member_count FROM public.esusu_members WHERE group_id = p_group_id;
  IF v_member_count >= v_group.max_members THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Circle is full');
  END IF;

  v_next_position := v_member_count + 1;
  INSERT INTO public.esusu_members (group_id, user_id, payout_position)
  VALUES (p_group_id, p_user_id, v_next_position);

  -- Transition forming → active when the last spot is filled; start the grace clock.
  IF v_next_position = v_group.max_members THEN
    UPDATE public.esusu_groups
    SET status = 'active', current_cycle = 1, cycle_started_at = now()
    WHERE id = p_group_id;
  END IF;

  RETURN jsonb_build_object('ok', true, 'position', v_next_position, 'is_full', (v_next_position = v_group.max_members));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.join_esusu_group(uuid, uuid) TO authenticated;

-- ── 3. esusu_autodebit — auto-debit + emergency-pot cover for the current cycle ─
CREATE OR REPLACE FUNCTION public.esusu_autodebit(p_grace_hours int DEFAULT 24)
RETURNS jsonb AS $$
DECLARE
  v_group       public.esusu_groups%rowtype;
  v_member      public.esusu_members%rowtype;
  v_bal         bigint;
  v_emg_pot     bigint;
  c_kobo        bigint;
  v_penalty     bigint;
  v_net         bigint;
  v_pot_share   bigint;
  v_emg_share   bigint;
  v_advance     bigint;
  v_ref         text;
  v_payout_res  jsonb;
  v_debited     int := 0;
  v_covered     int := 0;
  v_stuck       int := 0;
  v_payouts     int := 0;
BEGIN
  FOR v_group IN
    SELECT * FROM public.esusu_groups
    WHERE status = 'active'
      AND COALESCE(cycle_started_at, created_at) <= now() - make_interval(hours => p_grace_hours)
  LOOP
    c_kobo := v_group.contribution_amount_kobo;

    FOR v_member IN
      SELECT em.* FROM public.esusu_members em
      WHERE em.group_id = v_group.id
        AND NOT EXISTS (
          SELECT 1 FROM public.esusu_contributions ec
          WHERE ec.group_id = v_group.id AND ec.member_id = em.id
            AND ec.cycle_number = v_group.current_cycle
        )
    LOOP
      SELECT naira_balance_kobo INTO v_bal FROM public.wallets WHERE user_id = v_member.user_id FOR UPDATE;

      IF COALESCE(v_bal, 0) >= c_kobo THEN
        -- Normal auto-debit — same mechanics as a manual esusu_contribute.
        v_penalty   := floor(c_kobo * 0.005);
        v_net       := c_kobo - v_penalty;
        v_pot_share := floor(v_net * 95 / 100);
        v_emg_share := v_net - v_pot_share;
        v_ref       := 'esusu_autodebit_' || v_group.id::text || '_' || v_member.id::text || '_c' || v_group.current_cycle::text;

        UPDATE public.wallets SET naira_balance_kobo = naira_balance_kobo - c_kobo, updated_at = now()
        WHERE user_id = v_member.user_id;

        UPDATE public.esusu_groups
        SET pot_balance_kobo = pot_balance_kobo + v_pot_share,
            emergency_pot_kobo = emergency_pot_kobo + v_emg_share
        WHERE id = v_group.id;

        INSERT INTO public.esusu_contributions (group_id, member_id, cycle_number, amount_kobo)
        VALUES (v_group.id, v_member.id, v_group.current_cycle, v_net);

        INSERT INTO public.transactions (user_id, type, direction, amount_kobo, description, status)
        VALUES (v_member.user_id, 'esusu_contribute', 'debit', c_kobo,
                format('Ajo auto-debit – Cycle %s of "%s"', v_group.current_cycle, v_group.name), 'completed');

        IF v_penalty > 0 THEN
          INSERT INTO public.platform_fees (user_id, transaction_ref, fee_type, gross_amount_kobo, fee_amount_kobo, fee_percent)
          VALUES (v_member.user_id, v_ref, 'esusu_penalty', c_kobo, v_penalty, 0.50);
          UPDATE public.platform_settings
          SET value = (COALESCE(value::bigint, 0) + v_penalty)::text WHERE key = 'platform_revenue_kobo';
        END IF;

        v_debited := v_debited + 1;

      ELSE
        -- Short wallet → advance their pot share from the emergency pot if it can cover.
        v_advance := floor(c_kobo * 95 / 100);
        SELECT emergency_pot_kobo INTO v_emg_pot FROM public.esusu_groups WHERE id = v_group.id;

        IF COALESCE(v_emg_pot, 0) >= v_advance THEN
          UPDATE public.esusu_groups
          SET emergency_pot_kobo = emergency_pot_kobo - v_advance,
              pot_balance_kobo    = pot_balance_kobo + v_advance
          WHERE id = v_group.id;

          UPDATE public.esusu_members SET amount_owed_kobo = amount_owed_kobo + v_advance
          WHERE id = v_member.id;

          INSERT INTO public.esusu_contributions (group_id, member_id, cycle_number, amount_kobo)
          VALUES (v_group.id, v_member.id, v_group.current_cycle, v_advance);

          INSERT INTO public.transactions (user_id, type, direction, amount_kobo, description, status)
          VALUES (v_member.user_id, 'esusu_contribute', 'debit', 0,
                  format('Ajo missed – covered by emergency pot, Cycle %s of "%s" (₦%s owed from your payout)',
                         v_group.current_cycle, v_group.name, (v_advance / 100)::text), 'completed');

          v_covered := v_covered + 1;
        ELSE
          v_stuck := v_stuck + 1; -- can't cover; the cycle waits for this member
        END IF;
      END IF;
    END LOOP;

    -- Everyone now paid or covered? Pay the cycle out.
    v_payout_res := public.process_esusu_payout(v_group.id);
    IF v_payout_res->>'ok' = 'true' THEN
      v_payouts := v_payouts + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('debited', v_debited, 'covered', v_covered, 'stuck', v_stuck, 'payouts', v_payouts);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.esusu_autodebit(int) TO service_role;

-- ── 4. process_esusu_payout — clawback covered advances + restart grace clock ──
CREATE OR REPLACE FUNCTION public.process_esusu_payout(
  p_group_id uuid
) RETURNS jsonb AS $$
DECLARE
  v_group              public.esusu_groups%rowtype;
  v_member_count       int;
  v_contrib_count      int;
  v_recipient          public.esusu_members%rowtype;
  v_payout_kobo        bigint;
  v_creator_cut_kobo   bigint;
  v_net_payout_kobo    bigint;
  v_clawback_kobo      bigint := 0;
  v_payout_pos         int;
  v_next_cycle         int;
BEGIN
  SELECT * INTO v_group FROM public.esusu_groups WHERE id = p_group_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF v_group.status != 'active' THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_active'); END IF;

  SELECT COUNT(*) INTO v_member_count FROM public.esusu_members WHERE group_id = p_group_id;

  SELECT COUNT(DISTINCT ec.member_id) INTO v_contrib_count
  FROM public.esusu_contributions ec
  JOIN public.esusu_members em ON ec.member_id = em.id
  WHERE ec.group_id = p_group_id AND ec.cycle_number = v_group.current_cycle;

  IF v_contrib_count < v_member_count THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'incomplete', 'contributed', v_contrib_count, 'needed', v_member_count);
  END IF;

  v_payout_pos := ((v_group.current_cycle - 1) % v_member_count) + 1;
  SELECT * INTO v_recipient FROM public.esusu_members WHERE group_id = p_group_id AND payout_position = v_payout_pos;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_recipient'); END IF;

  v_payout_kobo      := v_group.pot_balance_kobo;
  v_next_cycle       := v_group.current_cycle + 1;

  -- Creator incentive: deducted from pot before recipient is paid.
  v_creator_cut_kobo := FLOOR(v_payout_kobo * v_group.creator_incentive_percent / 100.0);
  v_net_payout_kobo  := v_payout_kobo - v_creator_cut_kobo;

  -- Clawback: if this recipient owes the emergency pot (a covered miss), recover it
  -- from their payout and repay the emergency pot so it's made whole.
  IF v_recipient.amount_owed_kobo > 0 THEN
    v_clawback_kobo   := LEAST(v_recipient.amount_owed_kobo, v_net_payout_kobo);
    v_net_payout_kobo := v_net_payout_kobo - v_clawback_kobo;
    UPDATE public.esusu_groups SET emergency_pot_kobo = emergency_pot_kobo + v_clawback_kobo WHERE id = p_group_id;
    UPDATE public.esusu_members SET amount_owed_kobo = amount_owed_kobo - v_clawback_kobo WHERE id = v_recipient.id;
  END IF;

  -- Credit recipient (net of creator cut and clawback).
  UPDATE public.wallets
  SET naira_balance_kobo = naira_balance_kobo + v_net_payout_kobo, updated_at = now()
  WHERE user_id = v_recipient.user_id;

  INSERT INTO public.transactions (user_id, type, direction, amount_kobo, description)
  VALUES (v_recipient.user_id, 'esusu_payout', 'credit', v_net_payout_kobo,
          CASE WHEN v_clawback_kobo > 0
               THEN format('Ajo payout – Cycle %s of "%s" (₦%s recovered for a covered miss)', v_group.current_cycle, v_group.name, (v_clawback_kobo/100)::text)
               ELSE format('Ajo payout – Cycle %s of "%s"', v_group.current_cycle, v_group.name) END);

  -- Pay creator incentive (if any).
  IF v_creator_cut_kobo > 0 THEN
    UPDATE public.wallets
    SET naira_balance_kobo = naira_balance_kobo + v_creator_cut_kobo, updated_at = now()
    WHERE user_id = v_group.owner_id;

    INSERT INTO public.transactions (user_id, type, direction, amount_kobo, description)
    VALUES (v_group.owner_id, 'creator_incentive', 'credit', v_creator_cut_kobo,
            format('Creator incentive %.1f%% from "%s" Cycle %s', v_group.creator_incentive_percent, v_group.name, v_group.current_cycle));

    INSERT INTO public.platform_fees (user_id, fee_type, amount_usdc_micro, description)
    VALUES (v_group.owner_id, 'creator_incentive', 0,
            format('Creator incentive: %s kobo (%.1f%% of %s kobo) from group "%s" cycle %s',
                   v_creator_cut_kobo, v_group.creator_incentive_percent, v_payout_kobo, v_group.name, v_group.current_cycle));
  END IF;

  -- Advance group state; restart the grace clock for the new cycle.
  IF v_next_cycle > v_member_count THEN
    UPDATE public.esusu_groups SET pot_balance_kobo = 0, current_cycle = v_next_cycle, status = 'completed', cycle_started_at = now() WHERE id = p_group_id;
  ELSE
    UPDATE public.esusu_groups SET pot_balance_kobo = 0, current_cycle = v_next_cycle, cycle_started_at = now() WHERE id = p_group_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'paid_to', v_recipient.user_id, 'amount_kobo', v_net_payout_kobo,
    'creator_cut_kobo', v_creator_cut_kobo, 'clawback_kobo', v_clawback_kobo,
    'cycle', v_group.current_cycle, 'next_cycle', v_next_cycle, 'completed', (v_next_cycle > v_member_count));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.process_esusu_payout(uuid) TO authenticated, service_role;