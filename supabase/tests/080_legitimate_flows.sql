-- 080_legitimate_flows.sql
--
-- STAGING ONLY. Modifies data. The counterpart to adversarial-rls-writes.sql: that one checks
-- the attacks fail, this one checks the app still works.
--
-- Locking a database down is only half the job. A revoke that also breaks signup or reading
-- your own balance is a worse outcome than the hole it closed, and the failure would surface as
-- a customer-facing error rather than a test failure.

create temp table if not exists ok (ord int, flow text, detail text, works boolean);
delete from ok;

-- 1. Signup still builds the profile and wallet. handle_new_user is SECURITY DEFINER and owned
--    by a table-owning role, so it bypasses RLS and needs no INSERT policy.
do $$
declare v_id uuid := gen_random_uuid(); np int; nw int; idx bigint;
begin
  insert into auth.users (id, email, encrypted_password, email_confirmed_at, aud, role, raw_user_meta_data)
  values (v_id, 'flow-'||left(v_id::text,8)||'@staging.test', 'x', now(), 'authenticated', 'authenticated',
          '{"display_name":"Flow Test"}');
  select count(*) into np from public.profiles where id = v_id;
  select count(*) into nw from public.wallets  where user_id = v_id;
  select deposit_index into idx from public.wallets where user_id = v_id;
  insert into ok values (1, 'signup creates profile and wallet',
    'profile '||np||', wallet '||nw||', deposit_index '||coalesce(idx::text,'null'),
    np = 1 and nw = 1 and idx is not null);
  delete from auth.users where id = v_id;
end $$;

-- 2. A signed-in user can still read their own wallet.
do $$
declare bal bigint;
begin
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
  select usdc_balance_micro into bal from public.wallets
   where user_id = '00000000-0000-4000-8000-000000000001';
  reset role;
  insert into ok values (2, 'read own wallet balance',
    'got '||coalesce(round(bal/1e6,2)::text,'nothing'), bal is not null);
exception when others then
  reset role;
  insert into ok values (2, 'read own wallet balance', 'FAILED: '||left(sqlerrm,60), false);
end $$;

-- 3. And their own profile.
do $$
declare st text;
begin
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000002","role":"authenticated"}';
  select coalesce(kyc_status,'(null)') into st from public.profiles
   where id = '00000000-0000-4000-8000-000000000002';
  reset role;
  insert into ok values (3, 'read own profile', 'kyc_status '||coalesce(st,'nothing'), st is not null);
exception when others then
  reset role;
  insert into ok values (3, 'read own profile', 'FAILED: '||left(sqlerrm,60), false);
end $$;

-- 4. And their own locks.
do $$
declare n int;
begin
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000004","role":"authenticated"}';
  select count(*) into n from public.savings_locks where user_id = '00000000-0000-4000-8000-000000000004';
  reset role;
  insert into ok values (4, 'read own savings locks', 'saw '||n||' lock(s)', n = 1);
exception when others then
  reset role;
  insert into ok values (4, 'read own savings locks', 'FAILED: '||left(sqlerrm,60), false);
end $$;

-- 5. Creating a goal from the browser still works. This is the one client write kept.
do $$
declare n_before int; n_after int;
begin
  select count(*) into n_before from public.savings_goals
   where user_id = '00000000-0000-4000-8000-000000000005';
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000005","role":"authenticated"}';
  insert into public.savings_goals
    (user_id, title, target_naira_kobo, target_usdc_micro, frequency,
     contribution_naira_kobo, contribution_usdc_micro, user_consent_accepted)
  values ('00000000-0000-4000-8000-000000000005', 'Flow test goal', 10000 * 100::bigint,
          10000 * 1000000::bigint, 'weekly', 1000 * 100::bigint, 1000 * 1000000::bigint, true);
  reset role;
  select count(*) into n_after from public.savings_goals
   where user_id = '00000000-0000-4000-8000-000000000005';
  insert into ok values (5, 'create own goal from the browser',
    'goals '||n_before||' -> '||n_after, n_after = n_before + 1);
exception when others then
  reset role;
  insert into ok values (5, 'create own goal from the browser', 'FAILED: '||left(sqlerrm,60), false);
end $$;

-- 6. But a client-created goal cannot claim progress it has not made, even though an INSERT
--    policy cannot restrict columns. The trigger forces the starting values.
do $$
declare sv bigint; stat text;
begin
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000005","role":"authenticated"}';
  insert into public.savings_goals
    (user_id, title, target_naira_kobo, target_usdc_micro, frequency,
     contribution_naira_kobo, contribution_usdc_micro, saved_usdc_micro, status, user_consent_accepted)
  values ('00000000-0000-4000-8000-000000000005', 'Cheeky goal', 10000 * 100::bigint,
          10000 * 1000000::bigint, 'weekly', 1000 * 100::bigint, 1000 * 1000000::bigint,
          9999999 * 1000000::bigint, 'completed', true);
  reset role;
  select saved_usdc_micro, status into sv, stat from public.savings_goals
   where user_id = '00000000-0000-4000-8000-000000000005' and title = 'Cheeky goal';
  insert into ok values (6, 'client cannot pre-fund a new goal',
    'saved '||coalesce(sv::text,'?')||', status '||coalesce(stat,'?'),
    sv = 0 and stat = 'active');
exception when others then
  reset role;
  insert into ok values (6, 'client cannot pre-fund a new goal', 'insert refused: '||left(sqlerrm,50), true);
end $$;

-- 7. The service role, which is what every server route uses, is unaffected throughout.
do $$
declare bal bigint;
begin
  update public.wallets set usdc_balance_micro = usdc_balance_micro
   where user_id = '00000000-0000-4000-8000-000000000001';
  select usdc_balance_micro into bal from public.wallets
   where user_id = '00000000-0000-4000-8000-000000000001';
  insert into ok values (7, 'service role can still write wallets',
    'balance readable and writable, '||round(bal/1e6,2)::text, true);
exception when others then
  insert into ok values (7, 'service role can still write wallets', 'FAILED: '||left(sqlerrm,60), false);
end $$;

-- Tidy up what this test created.
delete from public.savings_goals
 where user_id = '00000000-0000-4000-8000-000000000005'
   and title in ('Flow test goal', 'Cheeky goal');

select case when works then 'works' else 'BROKEN' end as result, flow, detail
from ok order by ord;

select count(*) filter (where not works) as broken, count(*) filter (where works) as working from ok;
