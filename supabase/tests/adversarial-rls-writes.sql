-- adversarial-rls-writes.sql
--
-- STAGING ONLY. This MODIFIES the database. psql commits after each statement, so the writes
-- that succeed persist. Re-run seed-staging-users.sql afterwards to reset. Never point this at
-- production.
--
-- Revoking execute on the functions was necessary and is not sufficient. RLS policies grant
-- equivalent power directly on the tables, and a policy with a USING clause and no WITH CHECK
-- lets a client rewrite any column of a row it owns.
--
-- Simulates a real signed-in browser: role `authenticated` plus a request.jwt.claims sub, which
-- is what auth.uid() reads. If these succeed, the same call succeeds from the browser with
-- nothing but the public anon key and a login.

create temp table if not exists atk (ord int, attack text, outcome text, blocked boolean);
delete from atk;

-- 1. Can a signed-in user set their own wallet balance?
do $$
declare before_bal bigint; after_bal bigint;
begin
  select usdc_balance_micro into before_bal from public.wallets
   where user_id = '00000000-0000-4000-8000-000000000001';
  begin
    set local role authenticated;
    set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
    update public.wallets set usdc_balance_micro = 999999999 * 1000000::bigint
     where user_id = '00000000-0000-4000-8000-000000000001';
    reset role;
    select usdc_balance_micro into after_bal from public.wallets
     where user_id = '00000000-0000-4000-8000-000000000001';
    insert into atk values (1, 'set own wallet balance to 999,999,999',
      case when after_bal = before_bal then 'refused, balance unchanged'
           else 'SUCCEEDED, balance now '||round(after_bal/1e6,0) end,
      after_bal = before_bal);
  exception when others then
    reset role;
    insert into atk values (1, 'set own wallet balance to 999,999,999', 'refused: '||left(sqlerrm,60), true);
  end;
end $$;

-- 2. Can a signed-in user mark themselves KYC verified, lifting the withdrawal cap?
do $$
declare st text;
begin
  begin
    set local role authenticated;
    set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
    update public.profiles set kyc_status = 'verified', kyc_tier = 'full', kyc_verified_at = now()
     where id = '00000000-0000-4000-8000-000000000001';
    reset role;
    select kyc_status into st from public.profiles where id = '00000000-0000-4000-8000-000000000001';
    insert into atk values (2, 'self-elevate kyc_status to verified',
      case when st = 'verified' then 'SUCCEEDED, cap now lifted' else 'refused, still '||coalesce(st,'null') end,
      st is distinct from 'verified');
  exception when others then
    reset role;
    insert into atk values (2, 'self-elevate kyc_status to verified', 'refused: '||left(sqlerrm,60), true);
  end;
end $$;

-- 3. Can a signed-in user author their own ledger row?
do $$
declare n int;
begin
  begin
    set local role authenticated;
    set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
    insert into public.transactions (user_id, type, direction, amount_kobo, amount_usdc_micro, description, reference, status)
    values ('00000000-0000-4000-8000-000000000001', 'deposit', 'credit', 100000000, 1000000 * 1000000::bigint,
            'forged by the client', 'forged-'||gen_random_uuid()::text, 'completed');
    reset role;
    select count(*) into n from public.transactions where description = 'forged by the client';
    insert into atk values (3, 'author a fake deposit ledger row',
      case when n > 0 then 'SUCCEEDED, '||n||' row written' else 'refused' end, n = 0);
  exception when others then
    reset role;
    insert into atk values (3, 'author a fake deposit ledger row', 'refused: '||left(sqlerrm,60), true);
  end;
end $$;

-- 4. Can a signed-in user mature their own lock early, dodging the penalty?
do $$
declare unl timestamptz;
begin
  begin
    set local role authenticated;
    set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000004","role":"authenticated"}';
    update public.savings_locks set unlocks_at = now() - interval '1 day', status = 'matured'
     where user_id = '00000000-0000-4000-8000-000000000004';
    reset role;
    select unlocks_at into unl from public.savings_locks
     where user_id = '00000000-0000-4000-8000-000000000004' limit 1;
    insert into atk values (4, 'backdate own lock unlocks_at and mature it',
      case when unl < now() then 'SUCCEEDED, lock now matured early' else 'refused' end, unl >= now());
  exception when others then
    reset role;
    insert into atk values (4, 'backdate own lock unlocks_at and mature it', 'refused: '||left(sqlerrm,60), true);
  end;
end $$;

-- 5. Can a signed-in user inflate their own goal's saved amount?
do $$
declare sv bigint;
begin
  begin
    set local role authenticated;
    set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000005","role":"authenticated"}';
    update public.savings_goals set saved_usdc_micro = 9999999 * 1000000::bigint
     where user_id = '00000000-0000-4000-8000-000000000005';
    reset role;
    select saved_usdc_micro into sv from public.savings_goals
     where user_id = '00000000-0000-4000-8000-000000000005' limit 1;
    insert into atk values (5, 'inflate own goal saved_usdc_micro',
      case when sv > 1000000000000 then 'SUCCEEDED, goal now shows '||round(sv/1e6,0) else 'refused' end,
      sv <= 1000000000000);
  exception when others then
    reset role;
    insert into atk values (5, 'inflate own goal saved_usdc_micro', 'refused: '||left(sqlerrm,60), true);
  end;
end $$;

-- 6. Can a signed-in user change the transaction PIN directly? Migration 045's trigger should
--    stop this one, so it is the control case: if this is blocked and the rest are not, the
--    difference is that only the PIN got a trigger.
do $$
declare h text;
begin
  begin
    set local role authenticated;
    set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
    update public.profiles set transaction_pin_hash = 'forged-hash'
     where id = '00000000-0000-4000-8000-000000000001';
    reset role;
    select transaction_pin_hash into h from public.profiles where id = '00000000-0000-4000-8000-000000000001';
    insert into atk values (6, 'overwrite own transaction PIN hash',
      case when h = 'forged-hash' then 'SUCCEEDED' else 'refused' end, h is distinct from 'forged-hash');
  exception when others then
    reset role;
    insert into atk values (6, 'overwrite own transaction PIN hash', 'refused by trigger: '||left(sqlerrm,50), true);
  end;
end $$;

-- 7. Can a signed-in user write someone ELSE's wallet? The policies scope by auth.uid(), so
--    this should fail, which tells us the policies work as designed and the design is the
--    problem, not a broken policy.
do $$
declare before_bal bigint; after_bal bigint;
begin
  select usdc_balance_micro into before_bal from public.wallets
   where user_id = '00000000-0000-4000-8000-000000000003';
  begin
    set local role authenticated;
    set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
    update public.wallets set usdc_balance_micro = 1
     where user_id = '00000000-0000-4000-8000-000000000003';
    reset role;
    select usdc_balance_micro into after_bal from public.wallets
     where user_id = '00000000-0000-4000-8000-000000000003';
    insert into atk values (7, 'write ANOTHER user''s wallet',
      case when after_bal = before_bal then 'refused, as designed' else 'SUCCEEDED' end,
      after_bal = before_bal);
  exception when others then
    reset role;
    insert into atk values (7, 'write ANOTHER user''s wallet', 'refused: '||left(sqlerrm,60), true);
  end;
end $$;

select
  case when blocked then 'blocked' else 'EXPLOITABLE' end as result,
  attack, outcome
from atk order by ord;

select count(*) filter (where not blocked) as exploitable,
       count(*) filter (where blocked)     as blocked
from atk;
