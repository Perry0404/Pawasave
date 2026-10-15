-- 099_savings_and_esusu_authz_behaviour.sql
--
-- STAGING ONLY. Proves the mint described in 099's header is closed, and that the legitimate
-- paths it runs through still work.
--
-- Depends on seed-staging-users.sql having run: user ...004 owns an active 90-day lock and
-- ...001 is an ordinary lite-tier user.
--
-- Every authz check in 099 is written `IF auth.uid() IS NOT NULL AND ...`, so it is inert when
-- run as postgres. These blocks set local role + jwt claims the way PostgREST does, which is
-- the only way to exercise them.

create temp table if not exists r (ord int, name text, detail text, ok boolean);
delete from r;

-- Give ...004 a pool balance to lock from, and clear anything a previous run left.
update public.wallets set cngn_pool_micro = 100000 * 1000000::bigint
  where user_id = '00000000-0000-4000-8000-000000000004';
delete from public.savings_locks
  where user_id = '00000000-0000-4000-8000-000000000004' and apy_percent in (50.37, 50.33);

-- Migration 115 added a kill switch, fixed_savings_enabled, and ships it off: gNTB at ~14.5% cannot
-- fund the 20% fixed rate until GetEquity's credit fund is live. The hardening this file is about —
-- the owner check, the offered-term guard, p_apy being ignored — lives behind that switch, so it is
-- turned on for the duration and restored at the end. Assertion 0 proves the switch itself works.
do $$
declare msg text;
begin
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000004","role":"authenticated"}';
  begin
    perform public.lock_savings('00000000-0000-4000-8000-000000000004', 1000000, 100, 30, 999.99);
    msg := 'ALLOWED';
  exception when others then msg := SQLERRM;
  end;
  reset role;
  insert into r values (0, 'fixed savings is refused while the gate is off', msg,
    msg like '%coming soon%');
end $$;

update public.platform_settings set value = 'true' where key = 'fixed_savings_enabled';

-- 1. The mint's first half: a term nobody offers is refused, so the caller cannot buy 100
--    years of interest with a 36500-day lock.
do $$
declare msg text;
begin
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000004","role":"authenticated"}';
  begin
    perform public.lock_savings('00000000-0000-4000-8000-000000000004', 1000000, 100, 36500, 999.99);
    msg := 'NO ERROR';
  exception when others then msg := SQLERRM;
  end;
  reset role;
  insert into r values (1, 'a 36500-day term is refused', msg,
    msg like '%not an offered term%');
exception when others then
  reset role;
  insert into r values (1, 'a 36500-day term is refused', 'harness failed: '||SQLERRM, false);
end $$;

-- 2. The rate comes from the server, not from the caller. p_apy is accepted and ignored.
--
--    The figure changed with migration 115. 099 priced a term from
--    fixed_savings_rates.effective_rate_percent, so 30 days paid 4.14%. 115 prices every offered
--    term at fixed_user_apy_percent a year, prorated — 20% x 30/365 = 1.6438% — because the old
--    tiers reached 49.7% over a year and nothing funds that. What this assertion is actually about
--    is unchanged: the caller's p_apy of 999.99 has no effect either way.
do $$
declare v_lock uuid; v_proj bigint; v_eff numeric; v_annual numeric; v_expect numeric;
begin
  select value::numeric into v_annual from public.platform_settings
   where key = 'fixed_user_apy_percent';
  v_expect := round(v_annual * 30 / 365.0, 4);

  set local role authenticated;
  set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000004","role":"authenticated"}';
  v_lock := public.lock_savings('00000000-0000-4000-8000-000000000004', 1000 * 1000000, 1000 * 100, 30, 999.99);
  reset role;
  select projected_interest_micro, effective_rate_at_creation
    into v_proj, v_eff from public.savings_locks where id = v_lock;
  -- The projection is computed at 4 dp and the stored rate is narrowed to the column's 2, so a
  -- 30-day term projects on 1.6438% and records 1.64. Compared separately rather than conflated,
  -- because the figure that pays out is the projection.
  insert into r values (2, 'p_apy is ignored and the server prices the term',
    format('projected %s micro, effective %s, priced at %s (%s%% a year prorated)',
           v_proj, v_eff, v_expect, v_annual),
    v_eff = round(v_expect, 2) and v_proj = floor(1000 * 1000000 * v_expect / 100.0));
exception when others then
  reset role;
  insert into r values (2, 'p_apy is ignored and the server prices the term', 'failed: '||SQLERRM, false);
end $$;

-- 3. The mint's second half: the matured branch refuses a lock that has not matured, so
--    projected interest cannot be collected on a lock created seconds ago.
do $$
declare v_lock uuid; msg text; v_pool_before bigint; v_pool_after bigint;
begin
  select id into v_lock from public.savings_locks
   where user_id = '00000000-0000-4000-8000-000000000004' and status = 'active'
     and duration_days = 30 order by created_at desc limit 1;
  select cngn_pool_micro into v_pool_before from public.wallets
   where user_id = '00000000-0000-4000-8000-000000000004';
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000004","role":"authenticated"}';
  begin
    perform public.withdraw_lock('00000000-0000-4000-8000-000000000004', v_lock, false);
    msg := 'NO ERROR';
  exception when others then msg := SQLERRM;
  end;
  reset role;
  select cngn_pool_micro into v_pool_after from public.wallets
   where user_id = '00000000-0000-4000-8000-000000000004';
  insert into r values (3, 'an unmatured lock cannot take the matured branch',
    msg||' | pool moved '||(v_pool_after - v_pool_before)::text,
    msg like '%matures on%' and v_pool_after = v_pool_before);
exception when others then
  reset role;
  insert into r values (3, 'an unmatured lock cannot take the matured branch', 'harness failed: '||SQLERRM, false);
end $$;

-- 4. Breaking the same lock early still works, and pays principal less 0.5% with no interest.
do $$
declare v_lock uuid; res boolean; v_pool_before bigint; v_pool_after bigint; v_status text;
begin
  select id into v_lock from public.savings_locks
   where user_id = '00000000-0000-4000-8000-000000000004' and status = 'active'
     and duration_days = 30 order by created_at desc limit 1;
  select cngn_pool_micro into v_pool_before from public.wallets
   where user_id = '00000000-0000-4000-8000-000000000004';
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000004","role":"authenticated"}';
  res := public.withdraw_lock('00000000-0000-4000-8000-000000000004', v_lock, true);
  reset role;
  select cngn_pool_micro into v_pool_after from public.wallets
   where user_id = '00000000-0000-4000-8000-000000000004';
  select status into v_status from public.savings_locks where id = v_lock;
  insert into r values (4, 'breaking early still pays principal less 0.5%',
    'returned '||res::text||', pool +'||(v_pool_after - v_pool_before)::text||', status '||v_status,
    res and v_status = 'early_withdrawn' and (v_pool_after - v_pool_before) = 995000000);
exception when others then
  reset role;
  insert into r values (4, 'breaking early still pays principal less 0.5%', 'failed: '||SQLERRM, false);
end $$;

-- 5. Nobody can lock somebody else's pool.
do $$
declare msg text;
begin
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
  begin
    perform public.lock_savings('00000000-0000-4000-8000-000000000004', 1000000, 100, 30, 4.14);
    msg := 'NO ERROR';
  exception when others then msg := SQLERRM;
  end;
  reset role;
  insert into r values (5, 'locking another user''s pool is refused', msg,
    msg like '%unauthorized%');
exception when others then
  reset role;
  insert into r values (5, 'locking another user''s pool is refused', 'harness failed: '||SQLERRM, false);
end $$;

-- 6. esusu_contribute will not debit a user who is not the caller.
do $$
declare msg text;
begin
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
  begin
    perform public.esusu_contribute(
      '00000000-0000-4000-8000-000000000004', gen_random_uuid(), gen_random_uuid(), 100000, 1);
    msg := 'NO ERROR';
  exception when others then msg := SQLERRM;
  end;
  reset role;
  insert into r values (6, 'contributing on another user''s behalf is refused', msg,
    msg like '%unauthorized%');
exception when others then
  reset role;
  insert into r values (6, 'contributing on another user''s behalf is refused', 'harness failed: '||SQLERRM, false);
end $$;

-- 7. Even for yourself, the member row being credited has to be your own.
do $$
declare msg text;
begin
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
  begin
    perform public.esusu_contribute(
      '00000000-0000-4000-8000-000000000001', gen_random_uuid(), gen_random_uuid(), 100000, 1);
    msg := 'NO ERROR';
  exception when others then msg := SQLERRM;
  end;
  reset role;
  insert into r values (7, 'a member id that is not yours is refused', msg,
    msg like '%not your membership%');
exception when others then
  reset role;
  insert into r values (7, 'a member id that is not yours is refused', 'harness failed: '||SQLERRM, false);
end $$;

-- 8. A non-member cannot trigger a circle's payout.
do $$
declare msg text;
begin
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
  begin
    perform public.process_esusu_payout(gen_random_uuid());
    msg := 'NO ERROR';
  exception when others then msg := SQLERRM;
  end;
  reset role;
  insert into r values (8, 'a non-member cannot trigger a payout', msg,
    msg like '%not a member%');
exception when others then
  reset role;
  insert into r values (8, 'a non-member cannot trigger a payout', 'harness failed: '||SQLERRM, false);
end $$;

-- 9. A borrow limit is only ever your own.
do $$
declare msg text;
begin
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
  begin
    perform public.loan_borrow_limit('00000000-0000-4000-8000-000000000004');
    msg := 'NO ERROR';
  exception when others then msg := SQLERRM;
  end;
  reset role;
  insert into r values (9, 'reading another user''s borrow limit is refused', msg,
    msg like '%forbidden%');
exception when others then
  reset role;
  insert into r values (9, 'reading another user''s borrow limit is refused', 'harness failed: '||SQLERRM, false);
end $$;

-- 10. The cron path still works: as service_role auth.uid() is null, so the member check is
--     skipped and esusu_autodebit can still settle cycles.
do $$
declare res jsonb;
begin
  set local role service_role;
  res := public.esusu_autodebit(24);
  reset role;
  insert into r values (10, 'the autodebit cron is unaffected',
    'returned '||res::text, res ? 'debited');
exception when others then
  reset role;
  insert into r values (10, 'the autodebit cron is unaffected', 'failed: '||SQLERRM, false);
end $$;

-- Put the kill switch back as 115 ships it, or every later test in the run sees fixed savings on.
update public.platform_settings set value = 'false' where key = 'fixed_savings_enabled';

select ord, name, detail, case when ok then 'PASS' else 'FAIL' end as result
from r order by ord;
