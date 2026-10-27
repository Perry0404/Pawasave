-- 122_ajo_strike_fix.sql — Ajo strikes: one per missed cycle, removal at 4, collected members too
--
-- What was wrong with 070's esusu_autodebit (the nightly overdue sweep):
--   1. It added a strike on EVERY run while a cycle stayed unpaid. A circle stuck on one cycle
--      gave the same missed payment a fresh strike, and a fresh email, every night: one member
--      reached 38 strikes for what was really a single missed cycle.
--   2. A member who had already collected their payout was never removed, at any strike count.
--      A rotating circle only pays out once every ACTIVE member has paid the cycle, so that one
--      member froze the circle for everyone still waiting for their turn.
--
-- Now:
--   * At most one strike per member per cycle (last_strike_cycle).
--   * Removal at esusu_strike_limit strikes (platform_settings, default 4), whether or not the
--     member has collected. Removing them lets the circle carry on for everyone else.
--   * A removed member who had already collected is recorded as owing the group what they
--     still had to pay in: contribution × (cycles in the circle − contributions they made),
--     added to amount_owed_kobo, and the event says so (the cron emails it).
--   * Everything else in 070's body is unchanged: auto-debit from balance then savings pool, the
--     0.5% fee, pot/emergency split, idempotent ledger reference, payout attempt per circle.
--
-- Members already past the limit (e.g. 38 strikes) are removed on the next nightly run.
-- Safe to re-run.

ALTER TABLE public.esusu_members ADD COLUMN IF NOT EXISTS last_strike_cycle int;

INSERT INTO public.platform_settings (key, value) VALUES ('esusu_strike_limit', '4')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.esusu_autodebit(p_grace_hours int DEFAULT 24)
RETURNS jsonb AS $$
DECLARE
  v_group public.esusu_groups%rowtype;
  v_member public.esusu_members%rowtype;
  v_need_micro bigint; v_bal bigint; v_pool bigint; v_from_pool bigint;
  c_kobo bigint; v_penalty bigint; v_net bigint; v_ref text; v_new int;
  v_payout_res jsonb; v_events jsonb := '[]'::jsonb;
  v_debited int := 0; v_struck int := 0; v_removed int := 0; v_payouts int := 0;
  v_limit int := GREATEST(1, COALESCE((SELECT value::int FROM public.platform_settings WHERE key = 'esusu_strike_limit'), 4));
  v_cycles int; v_paid_n int; v_owed bigint;
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

      ELSIF v_member.last_strike_cycle IS DISTINCT FROM v_group.current_cycle
            OR v_member.missed_strikes >= v_limit THEN
        -- One strike per missed cycle. (Members already at or past the limit from the old
        -- per-night counting fall straight through to removal below.)
        v_new := CASE WHEN v_member.last_strike_cycle IS DISTINCT FROM v_group.current_cycle
                      THEN v_member.missed_strikes + 1 ELSE v_member.missed_strikes END;
        IF v_new >= v_limit THEN
          v_owed := 0;
          IF v_member.has_collected THEN
            -- They were paid the pot but stopped paying in: record what they still owed the group.
            SELECT COUNT(*) INTO v_cycles FROM public.esusu_members WHERE group_id = v_group.id;
            SELECT COUNT(*) INTO v_paid_n FROM public.esusu_contributions WHERE group_id = v_group.id AND member_id = v_member.id;
            v_owed := GREATEST(0, v_cycles - v_paid_n) * c_kobo;
          END IF;
          UPDATE public.esusu_members
          SET removed = true, removed_at = now(), missed_strikes = v_new, last_strike_cycle = v_group.current_cycle,
              amount_owed_kobo = amount_owed_kobo + v_owed
          WHERE id = v_member.id;
          v_removed := v_removed + 1;
          v_events := v_events || jsonb_build_object('user_id',v_member.user_id,'action','removed','group',v_group.name,
                        'cycle',v_group.current_cycle,'strikes',v_new,'owed_kobo',v_owed,'had_collected',v_member.has_collected);
        ELSE
          UPDATE public.esusu_members SET missed_strikes = v_new, last_strike_cycle = v_group.current_cycle WHERE id = v_member.id;
          v_struck := v_struck + 1;
          v_events := v_events || jsonb_build_object('user_id',v_member.user_id,'action','strike','group',v_group.name,
                        'cycle',v_group.current_cycle,'strikes',v_new,'limit',v_limit,'amount_kobo',c_kobo);
        END IF;
      END IF;
      -- Already struck for this cycle and still under the limit: nothing to do, no email.
    END LOOP;

    v_payout_res := public.process_esusu_payout(v_group.id);
    IF v_payout_res->>'ok' = 'true' THEN v_payouts := v_payouts + 1; END IF;
  END LOOP;

  RETURN jsonb_build_object('debited',v_debited,'struck',v_struck,'removed',v_removed,'payouts',v_payouts,'events',v_events);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
REVOKE ALL ON FUNCTION public.esusu_autodebit(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.esusu_autodebit(int) TO service_role;

-- readd_esusu_member (070) resets missed_strikes; also clear the per-cycle marker.
CREATE OR REPLACE FUNCTION public.esusu_clear_strike_marker() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.removed AND NOT NEW.removed THEN NEW.last_strike_cycle := NULL; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS esusu_members_clear_strike_marker ON public.esusu_members;
CREATE TRIGGER esusu_members_clear_strike_marker BEFORE UPDATE OF removed ON public.esusu_members
  FOR EACH ROW EXECUTE FUNCTION public.esusu_clear_strike_marker();
