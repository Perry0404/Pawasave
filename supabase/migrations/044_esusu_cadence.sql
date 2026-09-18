-- 044_esusu_cadence.sql
-- Item 3: make Esusu/Ajo cadence actually follow each circle's cycle_period.
--
-- cycle_period already supports daily/weekly/biweekly/monthly (001), and the create
-- screen now offers Daily/Weekly/Monthly. But esusu_autodebit (038) used ONE fixed
-- grace window (24h) for every circle — so a weekly or monthly circle would get its
-- members auto-debited only a day into the cycle, effectively forcing daily payments.
--
-- Fix: derive the grace window per-circle from cycle_period. A cycle runs for its
-- period; once the period has elapsed, unpaid members are auto-debited (or covered
-- from the emergency pot) exactly as before. Everything else in the defaulter model
-- — auto-debit, emergency-pot advance, clawback at payout — is unchanged (038).

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
  -- Only circles whose current cycle has run for its FULL period are due. p_grace_hours
  -- is retained for compatibility but the per-circle period is what drives cadence.
  FOR v_group IN
    SELECT * FROM public.esusu_groups
    WHERE status = 'active'
      AND COALESCE(cycle_started_at, created_at) <= now() - (CASE cycle_period
            WHEN 'daily'    THEN interval '1 day'
            WHEN 'weekly'   THEN interval '7 days'
            WHEN 'biweekly' THEN interval '14 days'
            ELSE                 interval '30 days'   -- monthly
          END)
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
          v_stuck := v_stuck + 1;
        END IF;
      END IF;
    END LOOP;

    v_payout_res := public.process_esusu_payout(v_group.id);
    IF v_payout_res->>'ok' = 'true' THEN
      v_payouts := v_payouts + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('debited', v_debited, 'covered', v_covered, 'stuck', v_stuck, 'payouts', v_payouts);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.esusu_autodebit(int) TO service_role;