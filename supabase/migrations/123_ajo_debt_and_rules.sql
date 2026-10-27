-- 123_ajo_debt_and_rules.sql — Ajo debt recovery, restrictions on debtors, circle rules in chat
--
-- 1. DEBT RECOVERY. A member removed while owing a circle (122 records amount_owed_kobo when a
--    member who already collected stops paying) has the debt taken automatically from any money
--    that reaches their PawaSave: a deposit, a transfer, a payout, savings moving back. Recovered
--    money goes to the people who were short:
--      circle still running → added to the pot, so the next payouts are whole again;
--      circle finished      → shared equally between the members who stayed.
--    Runs from a trigger on wallets, so every way money arrives is covered without touching each
--    deposit path. A failure inside recovery never blocks the deposit itself (caught and logged).
--
-- 2. RESTRICTIONS while a debt is open: cannot create or join a circle (enforced here, so the
--    mobile app is covered too), and cannot withdraw, send, pay or borrow (enforced in the API by
--    lib/ajo-debt.ts using ajo_debt_owed_kobo()).
--
-- 3. RULES IN THE CIRCLE CHAT. A system message from PawaSave is posted to the circle's chat:
--    when the circle is created (its rules), when someone joins (welcome + the rules), when a member
--    misses a cycle, when a member is removed, when debt is recovered, and when the circle completes.
--    Uses the chat_rooms/chat_messages system rows (094/095). If those tables are missing nothing
--    breaks: posting is best-effort.
--
-- Safe to re-run.

-- ── helpers ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ajo_debt_owed_kobo(p_user uuid)
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(SUM(amount_owed_kobo), 0)::bigint FROM public.esusu_members
  WHERE user_id = p_user AND removed AND amount_owed_kobo > 0
$$;
REVOKE ALL ON FUNCTION public.ajo_debt_owed_kobo(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ajo_debt_owed_kobo(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public._naira(p_kobo bigint) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT '₦' || to_char(COALESCE(p_kobo, 0) / 100.0, 'FM999,999,999,990.00')
$$;

CREATE OR REPLACE FUNCTION public._member_name(p_user uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(NULLIF(display_name, ''), CASE WHEN tag IS NOT NULL THEN '@' || tag END, 'A member')
  FROM public.profiles WHERE id = p_user
$$;

-- Best-effort system message into the circle's chat room.
CREATE OR REPLACE FUNCTION public.circle_system_post(p_group uuid, p_client_id text, p_body text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_room uuid;
BEGIN
  v_room := public.chat_room_for_circle(p_group);
  PERFORM public.chat_post_message(v_room, NULL, p_client_id, 'system', left(p_body, 1000), jsonb_build_object('source', 'pawasave'));
EXCEPTION WHEN others THEN
  RAISE WARNING 'circle_system_post %: %', p_group, SQLERRM;
END;
$$;
REVOKE ALL ON FUNCTION public.circle_system_post(uuid, text, text) FROM PUBLIC, anon, authenticated;

-- The rules of a circle in plain words.
CREATE OR REPLACE FUNCTION public.circle_rules_text(p_group uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  g public.esusu_groups%rowtype;
  v_limit int := COALESCE((SELECT value::int FROM public.platform_settings WHERE key = 'esusu_strike_limit'), 4);
  v_every text;
  v_rules text;
BEGIN
  SELECT * INTO g FROM public.esusu_groups WHERE id = p_group;
  IF NOT FOUND THEN RETURN ''; END IF;
  v_every := CASE g.cycle_period WHEN 'daily' THEN 'every day' WHEN 'weekly' THEN 'every week'
             WHEN 'biweekly' THEN 'every two weeks' ELSE 'every month' END;

  IF COALESCE(g.payout_mode, 'rotating') = 'rotating' THEN
    v_rules :=
      'Rules of this circle:' || E'\n' ||
      '1. Everyone pays ' || public._naira(g.contribution_amount_kobo) || ' ' || v_every || '.' || E'\n' ||
      '2. Each cycle one member collects the whole pot, in the order members joined.' || E'\n' ||
      '3. Your contribution is taken automatically from your PawaSave balance (then your savings) when it is due.' || E'\n' ||
      '4. If it cannot be taken, that is a missed cycle (a strike). ' || v_limit || ' missed cycles and you are removed.' || E'\n' ||
      '5. If you have already collected and stop paying, you are removed and what you still owe is taken automatically from any money that later reaches your PawaSave, and paid back to this circle. Until it is paid you cannot withdraw, send money, borrow, or join or create circles.' || E'\n' ||
      '6. PawaSave keeps 0.5% of each contribution. While money waits in the pot it earns interest.';
  ELSE
    v_rules :=
      'Rules of this circle:' || E'\n' ||
      '1. Members contribute toward the circle''s purpose' ||
        CASE WHEN g.goal_kobo IS NOT NULL THEN ' (target ' || public._naira(g.goal_kobo) || ')' ELSE '' END || '.' || E'\n' ||
      '2. The money is held by PawaSave in the circle''s pot, not by any one person.' || E'\n' ||
      '3. The pot is paid out only as the circle was set up to pay it.' || E'\n' ||
      '4. Every contribution is recorded and visible to members.' || E'\n' ||
      '5. PawaSave keeps 0.5% of each contribution.';
  END IF;
  RETURN v_rules;
END;
$$;
GRANT EXECUTE ON FUNCTION public.circle_rules_text(uuid) TO authenticated, service_role;

-- ── 1. debt recovery ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ajo_collect_debt(p_user uuid)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  m        record;
  w        public.wallets%rowtype;
  v_take   bigint;   -- micro
  v_kobo   bigint;
  v_from_b bigint;
  v_n      int;
  v_share  bigint;
  v_rem    bigint;
  r        record;
  v_total  bigint := 0;
  v_name   text := public._member_name(p_user);
BEGIN
  FOR m IN
    SELECT em.id, em.group_id, em.amount_owed_kobo, g.name, g.status
    FROM public.esusu_members em JOIN public.esusu_groups g ON g.id = em.group_id
    WHERE em.user_id = p_user AND em.removed AND em.amount_owed_kobo > 0
    ORDER BY em.removed_at NULLS LAST
    FOR UPDATE OF em
  LOOP
    SELECT * INTO w FROM public.wallets WHERE user_id = p_user FOR UPDATE;
    IF NOT FOUND THEN RETURN v_total; END IF;
    v_take := LEAST(COALESCE(w.usdc_balance_micro, 0) + COALESCE(w.cngn_pool_micro, 0), m.amount_owed_kobo * 10000);
    v_take := v_take - (v_take % 10000);            -- whole kobo only
    EXIT WHEN v_take <= 0;
    v_kobo := v_take / 10000;

    v_from_b := LEAST(v_take, COALESCE(w.usdc_balance_micro, 0));
    UPDATE public.wallets
    SET usdc_balance_micro = usdc_balance_micro - v_from_b,
        cngn_pool_micro    = cngn_pool_micro - (v_take - v_from_b),
        updated_at = now()
    WHERE user_id = p_user;

    UPDATE public.esusu_members SET amount_owed_kobo = amount_owed_kobo - v_kobo WHERE id = m.id;

    INSERT INTO public.transactions (user_id, type, direction, amount_kobo, amount_usdc_micro, description, reference, status)
    VALUES (p_user, 'esusu_contribute', 'debit', v_kobo, v_take,
            format('Ajo debt repaid to "%s"', m.name),
            'ajo_debt_' || m.id::text || '_' || (extract(epoch FROM clock_timestamp()) * 1000000)::bigint, 'completed');

    IF m.status IN ('forming', 'active') THEN
      UPDATE public.esusu_groups SET pot_balance_kobo = pot_balance_kobo + v_kobo WHERE id = m.group_id;
      PERFORM public.circle_system_post(m.group_id, 'debt:' || m.id || ':' || (extract(epoch FROM clock_timestamp()) * 1000000)::bigint,
        public._naira(v_kobo) || ' of ' || v_name || '''s unpaid contributions was recovered automatically and added to the pot.');
    ELSE
      -- Finished circle: share it between the members who stayed.
      SELECT COUNT(*) INTO v_n FROM public.esusu_members WHERE group_id = m.group_id AND NOT removed;
      IF v_n > 0 THEN
        v_share := (v_take / v_n) - ((v_take / v_n) % 10000);
        v_rem := v_take - v_share * v_n;
        FOR r IN SELECT user_id FROM public.esusu_members WHERE group_id = m.group_id AND NOT removed ORDER BY payout_position LOOP
          IF v_share + v_rem > 0 THEN
            UPDATE public.wallets SET usdc_balance_micro = usdc_balance_micro + v_share + v_rem, updated_at = now() WHERE user_id = r.user_id;
            INSERT INTO public.transactions (user_id, type, direction, amount_kobo, amount_usdc_micro, description, reference, status)
            VALUES (r.user_id, 'esusu_payout', 'credit', (v_share + v_rem) / 10000, v_share + v_rem,
                    format('Recovered Ajo contributions from "%s"', m.name),
                    'ajo_debt_share_' || m.id::text || '_' || r.user_id::text || '_' || (extract(epoch FROM clock_timestamp()) * 1000000)::bigint, 'completed');
            v_rem := 0;
          END IF;
        END LOOP;
        PERFORM public.circle_system_post(m.group_id, 'debt:' || m.id || ':' || (extract(epoch FROM clock_timestamp()) * 1000000)::bigint,
          public._naira(v_kobo) || ' of ' || v_name || '''s unpaid contributions was recovered and shared between the members.');
      END IF;
    END IF;

    v_total := v_total + v_take;
  END LOOP;
  RETURN v_total;
END;
$$;
REVOKE ALL ON FUNCTION public.ajo_collect_debt(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ajo_collect_debt(uuid) TO service_role;

-- Money arrives → collect. Never lets a recovery problem block the inflow.
CREATE OR REPLACE FUNCTION public.ajo_debt_on_inflow() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM public.esusu_members WHERE user_id = NEW.user_id AND removed AND amount_owed_kobo > 0) THEN
    BEGIN
      PERFORM public.ajo_collect_debt(NEW.user_id);
    EXCEPTION WHEN others THEN
      RAISE WARNING 'ajo debt recovery for %: %', NEW.user_id, SQLERRM;
    END;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS wallets_ajo_debt_on_inflow ON public.wallets;
CREATE TRIGGER wallets_ajo_debt_on_inflow
  AFTER UPDATE OF usdc_balance_micro, cngn_pool_micro ON public.wallets
  FOR EACH ROW
  WHEN (NEW.usdc_balance_micro > OLD.usdc_balance_micro OR NEW.cngn_pool_micro > OLD.cngn_pool_micro)
  EXECUTE FUNCTION public.ajo_debt_on_inflow();

-- ── 2. restrictions: no new circles while owing ──────────────────────────────
CREATE OR REPLACE FUNCTION public.ajo_block_debtor_circles() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user uuid;
BEGIN
  -- One function for both tables; read the column through jsonb so a missing field is NULL.
  v_user := CASE TG_TABLE_NAME WHEN 'esusu_members' THEN (to_jsonb(NEW)->>'user_id')::uuid
                               ELSE (to_jsonb(NEW)->>'owner_id')::uuid END;
  IF v_user IS NOT NULL AND public.ajo_debt_owed_kobo(v_user) > 0 THEN
    RAISE EXCEPTION 'You owe % to a circle you left. Pay it before joining or creating a circle.', public._naira(public.ajo_debt_owed_kobo(v_user));
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS esusu_members_block_debtor ON public.esusu_members;
CREATE TRIGGER esusu_members_block_debtor BEFORE INSERT ON public.esusu_members
  FOR EACH ROW EXECUTE FUNCTION public.ajo_block_debtor_circles();
DROP TRIGGER IF EXISTS esusu_groups_block_debtor ON public.esusu_groups;
CREATE TRIGGER esusu_groups_block_debtor BEFORE INSERT ON public.esusu_groups
  FOR EACH ROW EXECUTE FUNCTION public.ajo_block_debtor_circles();

-- ── 3. rules and events in the circle chat ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.circle_chat_on_group() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.circle_system_post(NEW.id, 'rules:' || NEW.id,
      'Welcome to "' || COALESCE(NEW.name, 'your circle') || '".' || E'\n\n' || public.circle_rules_text(NEW.id));
  ELSIF NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed' THEN
    PERFORM public.circle_system_post(NEW.id, 'completed:' || NEW.id,
      'This circle is complete. Every member has been paid. Thank you for showing up for each other. You can start a new circle any time.');
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS esusu_groups_chat ON public.esusu_groups;
CREATE TRIGGER esusu_groups_chat AFTER INSERT OR UPDATE OF status ON public.esusu_groups
  FOR EACH ROW EXECUTE FUNCTION public.circle_chat_on_group();

CREATE OR REPLACE FUNCTION public.circle_chat_on_member() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_name  text := public._member_name(NEW.user_id);
  v_limit int  := COALESCE((SELECT value::int FROM public.platform_settings WHERE key = 'esusu_strike_limit'), 4);
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.circle_system_post(NEW.group_id, 'join:' || NEW.id,
      v_name || ' joined the circle.' || E'\n\n' || public.circle_rules_text(NEW.group_id));
  ELSE
    IF NEW.removed AND NOT OLD.removed THEN
      PERFORM public.circle_system_post(NEW.group_id, 'removed:' || NEW.id || ':' || COALESCE(NEW.missed_strikes, 0),
        v_name || ' was removed from the circle after ' || COALESCE(NEW.missed_strikes, v_limit) || ' missed contributions.' ||
        CASE WHEN NEW.amount_owed_kobo > 0
             THEN ' They had already collected and still owe ' || public._naira(NEW.amount_owed_kobo) || ', which is taken automatically from any money that reaches their PawaSave and paid back to this circle.'
             ELSE '' END);
    ELSIF NOT NEW.removed AND COALESCE(NEW.missed_strikes, 0) > COALESCE(OLD.missed_strikes, 0) THEN
      PERFORM public.circle_system_post(NEW.group_id, 'strike:' || NEW.id || ':' || NEW.missed_strikes,
        v_name || ' missed a contribution (strike ' || NEW.missed_strikes || ' of ' || v_limit || '). After ' || v_limit || ' missed cycles a member is removed.');
    ELSIF OLD.removed AND NOT NEW.removed THEN
      PERFORM public.circle_system_post(NEW.group_id, 'readded:' || NEW.id || ':' || (extract(epoch FROM clock_timestamp()))::bigint,
        v_name || ' was added back to the circle.');
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS esusu_members_chat ON public.esusu_members;
CREATE TRIGGER esusu_members_chat AFTER INSERT OR UPDATE OF removed, missed_strikes ON public.esusu_members
  FOR EACH ROW EXECUTE FUNCTION public.circle_chat_on_member();

-- A removal that records a debt collects whatever the member has right away.
CREATE OR REPLACE FUNCTION public.ajo_debt_on_removal() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.removed AND NEW.amount_owed_kobo > COALESCE(OLD.amount_owed_kobo, 0) THEN
    BEGIN
      PERFORM public.ajo_collect_debt(NEW.user_id);
    EXCEPTION WHEN others THEN
      RAISE WARNING 'ajo debt recovery on removal %: %', NEW.user_id, SQLERRM;
    END;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS esusu_members_debt_on_removal ON public.esusu_members;
CREATE TRIGGER esusu_members_debt_on_removal AFTER UPDATE OF amount_owed_kobo ON public.esusu_members
  FOR EACH ROW EXECUTE FUNCTION public.ajo_debt_on_removal();
