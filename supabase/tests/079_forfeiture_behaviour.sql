-- 079_forfeiture_behaviour.sql
--
-- STAGING ONLY. Proves the forfeiture functions actually record something now, which they
-- never did before, and that they refuse the cases they should.
--
-- Depends on seed-staging-users.sql having run: user ...004 owns an active lock and user
-- ...005 owns an active goal.

create temp table if not exists r (ord int, name text, detail text, ok boolean);
delete from r;

-- 1. A real forfeiture on the owner's own lock records and returns true.
do $$
declare v_lock uuid; res boolean; jrows int; col bigint;
begin
  select id into v_lock from public.savings_locks
   where user_id = '00000000-0000-4000-8000-000000000004' and status = 'active' limit 1;
  delete from public.revenue_journal where user_id = '00000000-0000-4000-8000-000000000004';

  res := public.record_lock_forfeiture(v_lock, '00000000-0000-4000-8000-000000000004', 665000000);
  select count(*) into jrows from public.revenue_journal
   where user_id = '00000000-0000-4000-8000-000000000004' and revenue_type = 'lock_interest_forfeited';
  select interest_forfeited_usdc_micro into col from public.savings_locks where id = v_lock;

  insert into r values (1, 'lock forfeiture records',
    'returned '||res::text||', journal rows '||jrows||', column '||coalesce(col::text,'null'),
    res and jrows = 1 and col = 665000000);
end $$;

-- 2. Another user cannot record a forfeiture against that lock.
do $$
declare v_lock uuid; res boolean; jrows int;
begin
  select id into v_lock from public.savings_locks
   where user_id = '00000000-0000-4000-8000-000000000004' and status = 'active' limit 1;
  res := public.record_lock_forfeiture(v_lock, '00000000-0000-4000-8000-000000000001', 999000000);
  select count(*) into jrows from public.revenue_journal
   where user_id = '00000000-0000-4000-8000-000000000001';
  insert into r values (2, 'forfeiture on someone else''s lock refused',
    'returned '||res::text||', journal rows for the other user '||jrows,
    res = false and jrows = 0);
end $$;

-- 3. Zero or null amounts are refused rather than writing a meaningless journal row.
do $$
declare v_lock uuid; a boolean; b boolean;
begin
  select id into v_lock from public.savings_locks
   where user_id = '00000000-0000-4000-8000-000000000004' and status = 'active' limit 1;
  a := public.record_lock_forfeiture(v_lock, '00000000-0000-4000-8000-000000000004', 0);
  b := public.record_lock_forfeiture(v_lock, '00000000-0000-4000-8000-000000000004', null);
  insert into r values (3, 'zero and null amounts refused',
    'zero '||a::text||', null '||coalesce(b::text,'null'), a = false and b = false);
end $$;

-- 4. An id that does not exist returns false rather than silently succeeding.
do $$
declare res boolean;
begin
  res := public.record_lock_forfeiture(gen_random_uuid(), '00000000-0000-4000-8000-000000000004', 1000);
  insert into r values (4, 'unknown lock id returns false', 'returned '||res::text, res = false);
end $$;

-- 5. Same on the goal side.
do $$
declare v_goal uuid; res boolean; jrows int; col bigint;
begin
  select id into v_goal from public.savings_goals
   where user_id = '00000000-0000-4000-8000-000000000005' and status = 'active' limit 1;
  delete from public.revenue_journal where user_id = '00000000-0000-4000-8000-000000000005';

  res := public.record_goal_forfeiture(v_goal, '00000000-0000-4000-8000-000000000005', 924000000);
  select count(*) into jrows from public.revenue_journal
   where user_id = '00000000-0000-4000-8000-000000000005' and revenue_type = 'goal_interest_forfeited';
  select interest_forfeited_usdc_micro into col from public.savings_goals where id = v_goal;

  insert into r values (5, 'goal forfeiture records',
    'returned '||res::text||', journal rows '||jrows||', column '||coalesce(col::text,'null'),
    res and jrows = 1 and col = 924000000);
end $$;

-- 6. The old bigint signatures must be gone, or PostgREST has two candidates to choose from.
insert into r
select 6, 'no bigint signature remains',
       coalesce(string_agg(pg_get_function_identity_arguments(p.oid), ' | '), 'none'),
       count(*) = 0
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('record_lock_forfeiture', 'record_goal_forfeiture')
  and pg_get_function_identity_arguments(p.oid) like '%bigint,%';

-- 7. Not reachable from a browser.
insert into r
select 7, 'not client callable',
       coalesce(string_agg(p.proname, ', '), 'none reachable'), count(*) = 0
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('record_lock_forfeiture', 'record_goal_forfeiture')
  and (has_function_privilege('anon', p.oid, 'execute')
    or has_function_privilege('authenticated', p.oid, 'execute'));

select case when ok then 'PASS' else 'FAIL' end as result, name, detail from r order by ord;
select count(*) filter (where not ok) as failures from r;
