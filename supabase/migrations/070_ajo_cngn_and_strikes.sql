-- 070_ajo_cngn_and_strikes.sql  (run after 069)
--
-- Two coupled changes to Ajo/Esusu:
--  A. UNIFY ON cNGN. Contributions + payouts + creator incentive now move the single
--     cNGN balance (wallets.usdc_balance_micro, + cngn_pool_micro) instead of the legacy
--     naira_balance_kobo. This ends the phantom/dual-balance split (deposits are cNGN, so
--     Ajo now spends/credits the same money everything else does). Pot/emergency accounting
--     stays ₦-denominated (1 cNGN = 1 NGN). Existing phantom naira is cleared separately.
--  B. 3-STRIKE DEFAULTER POLICY (replaces the silent emergency-pot advance):
--     miss past grace → auto-debit attempt; if funds short → strike. Strike 3 → REMOVE from
--     the circle, but ONLY if they have not already collected a payout (if they collected,
--     they stay and their debt is recovered by the existing clawback). The creator can
--     re-add a removed member (readd_esusu_member). The cron emails the user at each step.
--
-- Idempotent (CREATE OR REPLACE / ADD COLUMN IF NOT EXISTS). Preserves creator incentive
-- (016) and emergency-pot clawback (038). Test on a throwaway circle before trusting.

-- ── schema ────────────────────────────────────────────────────────────────────
ALTER TABLE public.esusu_members
  ADD COLUMN IF NOT EXISTS missed_strikes int         NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS removed        boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS removed_at     timestamptz,
  ADD COLUMN IF NOT EXISTS has_collected  boolean     NOT NULL DEFAULT false;

-- Backfill has_collected: the old scheme paid payout_position p in cycle p, so a member
-- has collected iff their circle already advanced past their position.
UPDATE public.esusu_members em
SET has_collected = true
FROM public.esusu_groups g
WHERE g.id = em.group_id AND g.current_cycle > em.payout_position AND NOT em.has_collected;

-- ── A. esusu_contribute — debit cNGN (usdc_balance_micro + pool), reset strikes ──
CREATE OR REPLACE FUNCTION public.esusu_contribute(
  p_user_id uuid, p_group_id uuid, p_member_id uuid, p_amount_kobo bigint, p_cycle int
) RETURNS boolean AS $$
DECLARE
  w public.wallets%rowtype;
  v_need_micro bigint; v_from_pool bigint;
  v_penalty_kobo bigint; v_net_kobo bigint; v_ref text; v_gname text;
BEGIN
  v_need_micro := p_amount_kobo * 10000; -- kobo → cNGN micro (1 NGN = 1 cNGN)
  SELECT * INTO w FROM public.wallets WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF (w.usdc_balance_micro + COALESCE(w.cngn_pool_micro,0)) < v_need_micro THEN RETURN false; END IF;

  IF w.usdc_balance_micro < v_need_micro THEN
    v_from_pool := v_need_micro - w.usdc_balance_micro;
    UPDATE public.wallets SET cngn_pool_micro = cngn_pool_micro - v_from_pool,
                              usdc_balance_micro = usdc_balance_micro + v_from_pool
    WHERE user_id = p_user_id;
  END IF;

  v_penalty_kobo := floor(p_amount_kobo * 0.005);
  v_net_kobo := p_amount_kobo - v_penalty_kobo;
  v_ref := 'esusu_' || p_group_id::text || '_' || p_member_id::text || '_c' || p_cycle::text;
  SELECT name INTO v_gname FROM public.esusu_groups WHERE id = p_group_id;

  UPDATE public.wallets SET usdc_balance_micro = usdc_balance_micro - v_need_micro, updated_at = now()
  WHERE user_id = p_user_id;

  UPDATE public.esusu_groups
  SET pot_balance_kobo   = pot_balance_kobo + floor(v_net_kobo * 95 / 100),
      emergency_pot_kobo  = emergency_pot_kobo + (v_net_kobo - floor(v_net_kobo * 95 / 100))
  WHERE id = p_group_id;

  INSERT INTO public.esusu_contributions (group_id, member_id, cycle_number, amount_kobo)
  VALUES (p_group_id, p_member_id, p_cycle, v_net_kobo);

  UPDATE public.esusu_members SET missed_strikes = 0 WHERE id = p_member_id;

  IF NOT EXISTS (SELECT 1 FROM public.transactions WHERE reference = v_ref) THEN
    INSERT INTO public.transactions (user_id, type, direction, amount_kobo, amount_usdc_micro, description, reference, status)
    VALUES (p_user_id, 'esusu_contribute', 'debit', p_amount_kobo, v_need_micro,
            'Contributed to "' || COALESCE(v_gname,'Ajo') || '" (Cycle ' || p_cycle || ')', v_ref, 'completed');
  END IF;

  IF v_penalty_kobo > 0 THEN
    INSERT INTO public.platform_fees (user_id, transaction_ref, fee_type, gross_amount_kobo, fee_amount_kobo, fee_percent)
    VALUES (p_user_id, v_ref, 'esusu_penalty', p_amount_kobo, v_penalty_kobo, 0.50);
    UPDATE public.platform_settings SET value = (COALESCE(value::bigint,0) + v_penalty_kobo)::text WHERE key = 'platform_revenue_kobo';
  END IF;
  RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
GRANT EXECUTE ON FUNCTION public.esusu_contribute(uuid,uuid,uuid,bigint,int) TO authenticated, service_role;

-- ── A. process_esusu_payout — credit cNGN; removal-aware recipient; keep creator + clawback ──
CREATE OR REPLACE FUNCTION public.process_esusu_payout(p_group_id uuid)
RETURNS jsonb AS $$
DECLARE
  v_group public.esusu_groups%rowtype;
  v_member_count int; v_contrib_count int;
  v_recipient public.esusu_members%rowtype;
  v_payout_kobo bigint; v_creator_cut_kobo bigint; v_net_payout_kobo bigint; v_clawback_kobo bigint := 0;
  v_next_cycle int;
BEGIN
  SELECT * INTO v_group FROM public.esusu_groups WHERE id = p_group_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','not_found'); END IF;
  IF v_group.status <> 'active' THEN RETURN jsonb_build_object('ok',false,'reason','not_active'); END IF;

  -- only ACTIVE (non-removed) members count toward the cycle
  SELECT COUNT(*) INTO v_member_count FROM public.esusu_members WHERE group_id = p_group_id AND NOT removed;
  IF v_member_count = 0 THEN RETURN jsonb_build_object('ok',false,'reason','no_active_members'); END IF;

  SELECT COUNT(DISTINCT ec.member_id) INTO v_contrib_count
  FROM public.esusu_contributions ec
  JOIN public.esusu_members em ON ec.member_id = em.id
  WHERE ec.group_id = p_group_id AND ec.cycle_number = v_group.current_cycle AND NOT em.removed;

  IF v_contrib_count < v_member_count THEN
    RETURN jsonb_build_object('ok',false,'reason','incomplete','contributed',v_contrib_count,'needed',v_member_count);
  END IF;

  -- recipient = next active member who hasn't collected, in payout_position order
  SELECT * INTO v_recipient FROM public.esusu_members
  WHERE group_id = p_group_id AND NOT removed AND NOT has_collected
  ORDER BY payout_position LIMIT 1;
  IF NOT FOUND THEN
    UPDATE public.esusu_groups SET pot_balance_kobo = 0, status = 'completed' WHERE id = p_group_id;
    RETURN jsonb_build_object('ok',false,'reason','all_paid','completed',true);
  END IF;

  v_payout_kobo      := v_group.pot_balance_kobo;
  v_next_cycle       := v_group.current_cycle + 1;
  v_creator_cut_kobo := FLOOR(v_payout_kobo * v_group.creator_incentive_percent / 100.0);
  v_net_payout_kobo  := v_payout_kobo - v_creator_cut_kobo;

  IF v_recipient.amount_owed_kobo > 0 THEN
    v_clawback_kobo   := LEAST(v_recipient.amount_owed_kobo, v_net_payout_kobo);
    v_net_payout_kobo := v_net_payout_kobo - v_clawback_kobo;
    UPDATE public.esusu_groups  SET emergency_pot_kobo = emergency_pot_kobo + v_clawback_kobo WHERE id = p_group_id;
    UPDATE public.esusu_members SET amount_owed_kobo   = amount_owed_kobo   - v_clawback_kobo WHERE id = v_recipient.id;
  END IF;

  -- credit recipient in cNGN (net of creator cut + clawback)
  UPDATE public.wallets SET usdc_balance_micro = usdc_balance_micro + (v_net_payout_kobo * 10000), updated_at = now()
  WHERE user_id = v_recipient.user_id;
  UPDATE public.esusu_members SET has_collected = true WHERE id = v_recipient.id;

  INSERT INTO public.transactions (user_id, type, direction, amount_kobo, amount_usdc_micro, description)
  VALUES (v_recipient.user_id, 'esusu_payout', 'credit', v_net_payout_kobo, (v_net_payout_kobo * 10000),
          'Ajo payout – Cycle ' || v_group.current_cycle || ' of "' || v_group.name || '"');

  IF v_creator_cut_kobo > 0 THEN
    UPDATE public.wallets SET usdc_balance_micro = usdc_balance_micro + (v_creator_cut_kobo * 10000), updated_at = now()
    WHERE user_id = v_group.owner_id;
    INSERT INTO public.transactions (user_id, type, direction, amount_kobo, amount_usdc_micro, description)
    VALUES (v_group.owner_id, 'creator_incentive', 'credit', v_creator_cut_kobo, (v_creator_cut_kobo * 10000),
            format('Creator incentive %.1f%% from "%s" Cycle %s', v_group.creator_incentive_percent, v_group.name, v_group.current_cycle));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.esusu_members WHERE group_id = p_group_id AND NOT removed AND NOT has_collected) THEN
    UPDATE public.esusu_groups SET pot_balance_kobo = 0, current_cycle = v_next_cycle, cycle_started_at = now(), status = 'completed' WHERE id = p_group_id;
  ELSE
    UPDATE public.esusu_groups SET pot_balance_kobo = 0, current_cycle = v_next_cycle, cycle_started_at = now() WHERE id = p_group_id;
  END IF;

  RETURN jsonb_build_object('ok',true,'paid_to',v_recipient.user_id,'amount_kobo',v_net_payout_kobo,
    'creator_cut_kobo',v_creator_cut_kobo,'cycle',v_group.current_cycle,'next_cycle',v_next_cycle,
    'completed',(NOT EXISTS (SELECT 1 FROM public.esusu_members WHERE group_id = p_group_id AND NOT removed AND NOT has_collected)));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
GRANT EXECUTE ON FUNCTION public.process_esusu_payout(uuid) TO authenticated, service_role;

-- ── B. esusu_autodebit — cNGN auto-debit + 3-strike escalation + removal; returns events ──
CREATE OR REPLACE FUNCTION public.esusu_autodebit(p_grace_hours int DEFAULT 24)
RETURNS jsonb AS $$
DECLARE
  v_group public.esusu_groups%rowtype;
  v_member public.esusu_members%rowtype;
  v_need_micro bigint; v_bal bigint; v_pool bigint; v_from_pool bigint;
  c_kobo bigint; v_penalty bigint; v_net bigint; v_ref text; v_new int;
  v_payout_res jsonb; v_events jsonb := '[]'::jsonb;
  v_debited int := 0; v_struck int := 0; v_removed int := 0; v_payouts int := 0;
BEGIN
  FOR v_group IN
    SELECT * FROM public.esusu_groups WHERE status = 'active'
      AND COALESCE(cycle_started_at, created_at) <= now() - (CASE cycle_period
            WHEN 'daily' THEN interval '1 day' WHEN 'weekly' THEN interval '7 days'
            WHEN 'biweekly' THEN interval '14 days' ELSE interval '30 days' END)
  LOOP
    c_kobo := v_group.contribution_amount_kobo;
    v_need_micro := c_kobo * 10000;
    FOR v_member IN
      SELECT em.* FROM public.esusu_members em
      WHERE em.group_id = v_group.id AND NOT em.removed
        AND NOT EXISTS (SELECT 1 FROM public.esusu_contributions ec
                        WHERE ec.group_id = v_group.id AND ec.member_id = em.id AND ec.cycle_number = v_group.current_cycle)
    LOOP
      SELECT usdc_balance_micro, COALESCE(cngn_pool_micro,0) INTO v_bal, v_pool FROM public.wallets WHERE user_id = v_member.user_id FOR UPDATE;
      IF COALESCE(v_bal,0) + COALESCE(v_pool,0) >= v_need_micro THEN
        IF v_bal < v_need_micro THEN
          v_from_pool := v_need_micro - v_bal;
          UPDATE public.wallets SET cngn_pool_micro = cngn_pool_micro - v_from_pool, usdc_balance_micro = usdc_balance_micro + v_from_pool WHERE user_id = v_member.user_id;
        END IF;
        v_penalty := floor(c_kobo * 0.005); v_net := c_kobo - v_penalty;
        v_ref := 'esusu_autodebit_' || v_group.id::text || '_' || v_member.id::text || '_c' || v_group.current_cycle::text;
        UPDATE public.wallets SET usdc_balance_micro = usdc_balance_micro - v_need_micro, updated_at = now() WHERE user_id = v_member.user_id;
        UPDATE public.esusu_groups SET pot_balance_kobo = pot_balance_kobo + floor(v_net*95/100),
               emergency_pot_kobo = emergency_pot_kobo + (v_net - floor(v_net*95/100)) WHERE id = v_group.id;
        INSERT INTO public.esusu_contributions (group_id, member_id, cycle_number, amount_kobo) VALUES (v_group.id, v_member.id, v_group.current_cycle, v_net);
        UPDATE public.esusu_members SET missed_strikes = 0 WHERE id = v_member.id;
        IF NOT EXISTS (SELECT 1 FROM public.transactions WHERE reference = v_ref) THEN
          INSERT INTO public.transactions (user_id, type, direction, amount_kobo, amount_usdc_micro, description, reference, status)
          VALUES (v_member.user_id, 'esusu_contribute', 'debit', c_kobo, v_need_micro,
                  format('Ajo auto-debit – Cycle %s of "%s"', v_group.current_cycle, v_group.name), v_ref, 'completed');
        END IF;
        IF v_penalty > 0 THEN
          INSERT INTO public.platform_fees (user_id, transaction_ref, fee_type, gross_amount_kobo, fee_amount_kobo, fee_percent) VALUES (v_member.user_id, v_ref, 'esusu_penalty', c_kobo, v_penalty, 0.50);
          UPDATE public.platform_settings SET value = (COALESCE(value::bigint,0)+v_penalty)::text WHERE key = 'platform_revenue_kobo';
        END IF;
        v_debited := v_debited + 1;
        v_events := v_events || jsonb_build_object('user_id',v_member.user_id,'action','debited','group',v_group.name,'cycle',v_group.current_cycle,'amount_kobo',c_kobo);
      ELSE
        v_new := v_member.missed_strikes + 1;
        IF v_new >= 3 AND NOT v_member.has_collected THEN
          UPDATE public.esusu_members SET removed = true, removed_at = now(), missed_strikes = v_new WHERE id = v_member.id;
          v_removed := v_removed + 1;
          v_events := v_events || jsonb_build_object('user_id',v_member.user_id,'action','removed','group',v_group.name,'cycle',v_group.current_cycle,'strikes',v_new);
        ELSE
          UPDATE public.esusu_members SET missed_strikes = v_new WHERE id = v_member.id;
          v_struck := v_struck + 1;
          v_events := v_events || jsonb_build_object('user_id',v_member.user_id,'action','strike','group',v_group.name,'cycle',v_group.current_cycle,'strikes',v_new,'amount_kobo',c_kobo);
        END IF;
      END IF;
    END LOOP;

    v_payout_res := public.process_esusu_payout(v_group.id);
    IF v_payout_res->>'ok' = 'true' THEN v_payouts := v_payouts + 1; END IF;
  END LOOP;

  RETURN jsonb_build_object('debited',v_debited,'struck',v_struck,'removed',v_removed,'payouts',v_payouts,'events',v_events);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
GRANT EXECUTE ON FUNCTION public.esusu_autodebit(int) TO service_role;

-- ── B. readd_esusu_member — creator re-adds a removed member (grace) ─────────────
CREATE OR REPLACE FUNCTION public.readd_esusu_member(p_group_id uuid, p_member_id uuid)
RETURNS boolean AS $$
DECLARE v_owner uuid;
BEGIN
  SELECT owner_id INTO v_owner FROM public.esusu_groups WHERE id = p_group_id;
  IF v_owner IS NULL THEN RETURN false; END IF;
  IF auth.uid() IS NOT NULL AND auth.uid() <> v_owner THEN
    RAISE EXCEPTION 'readd_esusu_member: only the circle creator can re-add a member';
  END IF;
  UPDATE public.esusu_members SET removed = false, removed_at = NULL, missed_strikes = 0
  WHERE id = p_member_id AND group_id = p_group_id;
  RETURN FOUND;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
GRANT EXECUTE ON FUNCTION public.readd_esusu_member(uuid,uuid) TO authenticated, service_role;
