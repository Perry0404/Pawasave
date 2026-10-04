--
-- STAGING ONLY. Modifies data. Proves the invest identity gates actually fire for a profile with
-- NULL onboarding columns, and still let a verified or BVN-onboarded user through.
--
-- The bug this covers: `IF NOT (a OR b OR c)` where any of a/b/c is NULL evaluates to NULL, and
-- `IF NULL THEN` does nothing. So the gate was skipped for exactly the users it existed to stop.
--
-- Depends on seed-staging-users.sql:
--   ...001  kyc 'pending', no VA, onboarding NULL   -> no identity, must be refused
--   ...002  kyc 'pending', VA set                   -> has identity, must pass
--   ...003  kyc 'verified'                          -> has identity, must pass

create temp table if not exists r (ord int, name text, detail text, ok boolean);
delete from r;

-- 0. The fixture is the shape the bug needed: a NULL in the middle of the OR chain.
do $$
declare v_kyc text; v_onb text; v_va text; v_raw boolean;
begin
  select kyc_status, strails_onboard_status, strails_va_account_number
    into v_kyc, v_onb, v_va from public.profiles
   where id = '00000000-0000-4000-8000-000000000001';

  -- The old expression, evaluated here rather than described. NULL is the whole point.
  v_raw := NOT (v_kyc = 'verified' OR v_onb = 'completed' OR coalesce(v_va,'') <> '');

  insert into r values (0, 'the old guard expression evaluates to NULL for this user',
    format('kyc=%s onboard=%s va=%s -> NOT(...) is %s',
           coalesce(v_kyc,'NULL'), coalesce(v_onb,'NULL'), coalesce(v_va,'NULL'),
           coalesce(v_raw::text,'NULL')),
    v_raw is null);
end $$;

-- 1. And the helper answers a plain false for the same user.
do $$
declare v_ok boolean;
begin
  v_ok := public.has_invest_identity('00000000-0000-4000-8000-000000000001');
  insert into r values (1, 'has_invest_identity returns false, never NULL',
    coalesce(v_ok::text,'NULL'), v_ok is false);
end $$;

-- 2. A user_id with no profile row at all is also false, not NULL.
do $$
declare v_ok boolean;
begin
  v_ok := public.has_invest_identity('00000000-0000-4000-8000-0000000000ff');
  insert into r values (2, 'a missing profile is false, not NULL',
    coalesce(v_ok::text,'NULL'), v_ok is false);
end $$;

-- Fund the wallet and remember the balance in their OWN blocks, before the attempt.
--
-- This has to be separate from the block that raises. A caught exception in PL/pgSQL rolls the
-- whole block back to its start, so setup done inside the failing block is undone with it — an
-- earlier draft funded the wallet in the same block and then asserted against a balance that had
-- been rolled back to the seed value.
create temp table if not exists bal (who text, micro bigint);
delete from bal;

do $$
begin
  update public.wallets set usdc_balance_micro = 50000 * 1000000::bigint
   where user_id = '00000000-0000-4000-8000-000000000001';
  insert into bal
    select 'before', usdc_balance_micro from public.wallets
     where user_id = '00000000-0000-4000-8000-000000000001';
end $$;

-- 3. BUYING is refused for the unverified user. This is the hole.
do $$
declare v_order bigint;
begin
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
  v_order := public.place_equity_order('00000000-0000-4000-8000-000000000001',
    'AAPL', 'tokenized_stock', 'base_dex', 5000 * 1000000::bigint);
  reset role;
  insert into r values (3, 'an unverified user cannot buy', 'ALLOWED order '||v_order::text, false);
exception when others then
  reset role;
  insert into r values (3, 'an unverified user cannot buy', left(sqlerrm,60),
    sqlerrm like '%identity not verified%');
end $$;

-- 4. Nothing was debited and no order row exists.
do $$
declare v_bal bigint; v_before bigint; v_orders int;
begin
  select micro into v_before from bal where who = 'before';
  select usdc_balance_micro into v_bal from public.wallets
   where user_id = '00000000-0000-4000-8000-000000000001';
  select count(*) into v_orders from public.equity_orders
   where user_id = '00000000-0000-4000-8000-000000000001';
  insert into r values (4, 'the refused buy left the balance and the order table alone',
    format('balance %s (was %s), orders %s', v_bal, v_before, v_orders),
    v_bal = v_before and v_orders = 0);
end $$;

-- 5. SELLING is refused for the unverified user.
do $$
declare v_sale bigint;
begin
  insert into public.portfolio_holdings
    (user_id, symbol, asset_type, provider, invested_cngn_micro, shares)
  values
    ('00000000-0000-4000-8000-000000000001', 'NULLTEST', 'tokenized_stock', 'base_dex',
     100000 * 1000000::bigint, 10)
  on conflict (user_id, symbol, provider) do update set shares = 10, pledged_loan_id = null;

  set local role authenticated;
  set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
  v_sale := public.place_equity_sell('00000000-0000-4000-8000-000000000001', 'NULLTEST', 'base_dex', 1);
  reset role;
  insert into r values (5, 'an unverified user cannot sell', 'ALLOWED sale '||v_sale::text, false);
exception when others then
  reset role;
  insert into r values (5, 'an unverified user cannot sell', left(sqlerrm,60),
    sqlerrm like '%identity not verified%');
end $$;

-- 6. The RWA buy path is gated too.
do $$
declare v_order bigint;
begin
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
  v_order := public.place_getequity_order('00000000-0000-4000-8000-000000000001',
    'NTBS5', '0x0000000000000000000000000000000000000001', 5000 * 1000000::bigint, 0);
  reset role;
  insert into r values (6, 'an unverified user cannot buy an RWA', 'ALLOWED order '||v_order::text, false);
exception when others then
  reset role;
  insert into r values (6, 'an unverified user cannot buy an RWA', left(sqlerrm,60),
    sqlerrm like '%identity not verified%');
end $$;

-- 7. A BVN-onboarded user with a VA number but no biometric KYC still passes. The gate closed a
--    hole; it must not have quietly become the stricter borrowing rule.
do $$
declare v_order bigint; v_ok boolean;
begin
  v_ok := public.has_invest_identity('00000000-0000-4000-8000-000000000002');
  update public.wallets set usdc_balance_micro = 50000 * 1000000::bigint
   where user_id = '00000000-0000-4000-8000-000000000002';

  set local role authenticated;
  set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000002","role":"authenticated"}';
  v_order := public.place_equity_order('00000000-0000-4000-8000-000000000002',
    'AAPL', 'tokenized_stock', 'base_dex', 5000 * 1000000::bigint);
  reset role;
  insert into r values (7, 'a VA number alone is still enough to invest',
    format('helper %s, order %s', v_ok, v_order), v_ok is true and v_order is not null);
exception when others then
  reset role;
  insert into r values (7, 'a VA number alone is still enough to invest',
    'REFUSED: '||left(sqlerrm,60), false);
end $$;

-- 8. And a fully verified user passes.
do $$
declare v_ok boolean;
begin
  v_ok := public.has_invest_identity('00000000-0000-4000-8000-000000000003');
  insert into r values (8, 'a Sense-verified user passes', coalesce(v_ok::text,'NULL'), v_ok is true);
end $$;

-- 9. An empty-string VA number is not a VA number. 064 accepted it via IS NOT NULL.
do $$
declare v_ok boolean;
begin
  update public.profiles set strails_va_account_number = ''
   where id = '00000000-0000-4000-8000-000000000001';
  v_ok := public.has_invest_identity('00000000-0000-4000-8000-000000000001');
  update public.profiles set strails_va_account_number = null
   where id = '00000000-0000-4000-8000-000000000001';
  insert into r values (9, 'an empty VA number does not count as identity',
    coalesce(v_ok::text,'NULL'), v_ok is false);
end $$;

-- Tidy up.
delete from public.equity_orders where user_id = '00000000-0000-4000-8000-000000000002'
   and symbol = 'AAPL' and status = 'pending';
delete from public.portfolio_holdings where symbol = 'NULLTEST';

select ord, name, detail, case when ok then 'PASS' else 'FAIL' end as result
from r order by ord;
