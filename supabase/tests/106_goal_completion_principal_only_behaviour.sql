-- 106_goal_completion_principal_only_behaviour.sql
--
-- STAGING ONLY. Proves completing a goal returns principal and mints nothing, and that the guards
-- around it still hold.
--
-- Depends on seed-staging-users.sql: user ...005 owns a part-funded goal.

create temp table if not exists r (ord int, name text, detail text, ok boolean);
delete from r;

-- A goal already at its target, owned by ...005.
do $$
declare v_goal uuid;
begin
  delete from public.savings_goals where title = 'Completion test goal';
  insert into public.savings_goals
    (user_id, title, target_naira_kobo, target_usdc_micro, frequency,
     contribution_naira_kobo, contribution_usdc_micro,
     saved_naira_kobo, saved_usdc_micro, status, started_at)
  values
    ('00000000-0000-4000-8000-000000000005', 'Completion test goal',
     50000 * 100, 50000 * 1000000::bigint, 'weekly',
     5000 * 100, 5000 * 1000000::bigint,
     50000 * 100, 50000 * 1000000::bigint, 'active', now() - interval '200 days')
  returning id into v_goal;
end $$;

-- 1. Completion returns exactly the principal. 200 days at the old 33% a year would have added
--    about ₦9,041 of cNGN that nothing funds.
do $$
declare v_goal uuid; before bigint; after bigint; v_interest bigint; v_status text;
begin
  select id into v_goal from public.savings_goals where title = 'Completion test goal';
  select usdc_balance_micro into before from public.wallets
   where user_id = '00000000-0000-4000-8000-000000000005';

  set local role authenticated;
  set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000005","role":"authenticated"}';
  v_interest := public.complete_savings_goal(v_goal, '00000000-0000-4000-8000-000000000005');
  reset role;

  select usdc_balance_micro into after from public.wallets
   where user_id = '00000000-0000-4000-8000-000000000005';
  select status into v_status from public.savings_goals where id = v_goal;

  insert into r values (1, 'completion pays principal and nothing more',
    'wallet +' || (after - before) || ' micro, interest returned ' || v_interest ||
    ', status ' || v_status,
    (after - before) = 50000 * 1000000::bigint and v_interest = 0 and v_status = 'completed');
exception when others then
  reset role;
  insert into r values (1, 'completion pays principal and nothing more', 'failed: ' || SQLERRM, false);
end $$;

-- 2. interest_earned_micro is written as zero rather than left at a stale figure.
do $$
declare v_earned bigint;
begin
  select interest_earned_micro into v_earned from public.savings_goals
   where title = 'Completion test goal';
  insert into r values (2, 'the interest column says zero, not a stale number',
    coalesce(v_earned::text, 'null'), v_earned = 0);
end $$;

-- 3. There is a ledger row behind the credit. The old body wrote none, so money appeared in a wallet
--    with no transaction against it.
do $$
declare v_rows int; v_micro bigint;
begin
  select count(*), max(amount_usdc_micro) into v_rows, v_micro
  from public.transactions
  where user_id = '00000000-0000-4000-8000-000000000005'
    and type = 'goal_claim'
    and description like '%Completion test goal%';
  insert into r values (3, 'the credit has a transaction behind it',
    v_rows || ' row(s), ' || coalesce(v_micro::text, 'null') || ' micro',
    v_rows = 1 and v_micro = 50000 * 1000000::bigint);
end $$;

-- 4. A goal short of its target still cannot be completed.
do $$
declare v_goal uuid; msg text;
begin
  delete from public.savings_goals where title = 'Short goal';
  insert into public.savings_goals
    (user_id, title, target_naira_kobo, target_usdc_micro, frequency,
     contribution_naira_kobo, contribution_usdc_micro,
     saved_naira_kobo, saved_usdc_micro, status)
  values
    ('00000000-0000-4000-8000-000000000005', 'Short goal',
     50000 * 100, 50000 * 1000000::bigint, 'weekly', 5000 * 100, 5000 * 1000000::bigint,
     1000 * 100, 1000 * 1000000::bigint, 'active')
  returning id into v_goal;

  set local role authenticated;
  set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000005","role":"authenticated"}';
  begin
    perform public.complete_savings_goal(v_goal, '00000000-0000-4000-8000-000000000005');
    msg := 'NO ERROR';
  exception when others then msg := SQLERRM;
  end;
  reset role;
  insert into r values (4, 'a goal short of target is refused', msg, msg like '%target not yet reached%');
exception when others then
  reset role;
  insert into r values (4, 'a goal short of target is refused', 'harness failed: ' || SQLERRM, false);
end $$;

-- 5. Somebody else's goal cannot be completed.
do $$
declare v_goal uuid; msg text;
begin
  select id into v_goal from public.savings_goals where title = 'Short goal';
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
  begin
    perform public.complete_savings_goal(v_goal, '00000000-0000-4000-8000-000000000005');
    msg := 'NO ERROR';
  exception when others then msg := SQLERRM;
  end;
  reset role;
  insert into r values (5, 'completing another user''s goal is refused', msg, msg like '%unauthorized%');
exception when others then
  reset role;
  insert into r values (5, 'completing another user''s goal is refused', 'harness failed: ' || SQLERRM, false);
end $$;

-- 6. Completing twice is refused, so the principal cannot be drawn more than once.
do $$
declare v_goal uuid; msg text;
begin
  select id into v_goal from public.savings_goals where title = 'Completion test goal';
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000005","role":"authenticated"}';
  begin
    perform public.complete_savings_goal(v_goal, '00000000-0000-4000-8000-000000000005');
    msg := 'NO ERROR';
  exception when others then msg := SQLERRM;
  end;
  reset role;
  insert into r values (6, 'a completed goal cannot be completed again', msg,
    msg like '%not active%');
exception when others then
  reset role;
  insert into r values (6, 'a completed goal cannot be completed again', 'harness failed: ' || SQLERRM, false);
end $$;

-- 7. Breaking early still charges the 0.5% fee, so finishing is the better outcome.
do $$
declare v_goal uuid; before bigint; after bigint; expected bigint;
begin
  select id into v_goal from public.savings_goals where title = 'Short goal';
  select usdc_balance_micro into before from public.wallets
   where user_id = '00000000-0000-4000-8000-000000000005';

  set local role authenticated;
  set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000005","role":"authenticated"}';
  perform public.break_savings_goal(v_goal, '00000000-0000-4000-8000-000000000005');
  reset role;

  select usdc_balance_micro into after from public.wallets
   where user_id = '00000000-0000-4000-8000-000000000005';
  -- ₦1,000 saved, less 0.5%.
  expected := (1000 * 1000000::bigint) - floor(1000 * 1000000::bigint * 0.005);
  insert into r values (7, 'breaking early still costs 0.5%, so finishing is better',
    'wallet +' || (after - before) || ', expected ' || expected, (after - before) = expected);
exception when others then
  reset role;
  insert into r values (7, 'breaking early still costs 0.5%, so finishing is better',
    'failed: ' || SQLERRM, false);
end $$;

select ord, name, detail, case when ok then 'PASS' else 'FAIL' end as result
from r order by ord;
