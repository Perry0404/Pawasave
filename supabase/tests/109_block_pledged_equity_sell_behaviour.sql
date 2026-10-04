--
-- STAGING ONLY. Modifies data. Proves a pledged stock holding cannot be sold, and that 109 kept
-- every gate 098 had rather than reverting one the way 088 did.
--
-- Depends on seed-staging-users.sql. Uses ...003, the only seeded user with real identity
-- (kyc_status 'verified' plus a VA number), so these assertions are about pledging rather than
-- about the identity gate.
--
-- An earlier draft used ...004 and every sell "worked". ...004 has no identity at all: the sells
-- were only succeeding because the gate was NULL-poisoned, which is what migration 110 fixes. The
-- test was green for the wrong reason until 110 made it fail.

create temp table if not exists r (ord int, name text, detail text, ok boolean);
delete from r;

-- A free tokenised holding for ...004 to sell.
do $$
begin
  delete from public.portfolio_holdings
   where user_id = '00000000-0000-4000-8000-000000000003' and symbol in ('PLGTEST', 'RWATEST');
  insert into public.portfolio_holdings
    (user_id, symbol, asset_type, provider, invested_cngn_micro, shares)
  values
    ('00000000-0000-4000-8000-000000000003', 'PLGTEST', 'tokenized_stock', 'base_dex',
     100000 * 1000000::bigint, 10);
end $$;

-- 1. Baseline: an unpledged holding sells. Without this the rest proves nothing, since every
--    later refusal could just be a broken fixture.
do $$
declare v_sale bigint;
begin
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';
  v_sale := public.place_equity_sell('00000000-0000-4000-8000-000000000003', 'PLGTEST', 'base_dex', 1);
  reset role;
  insert into r values (1, 'an unpledged holding still sells', 'sale '||v_sale::text, v_sale is not null);
exception when others then
  reset role;
  insert into r values (1, 'an unpledged holding still sells', 'REFUSED: '||left(sqlerrm,70), false);
end $$;

-- 2. The shares and the cost basis both came down, proportionally. 098's average-cost fix.
do $$
declare v_shares numeric; v_cost bigint; v_removed bigint;
begin
  select shares, invested_cngn_micro into v_shares, v_cost from public.portfolio_holdings
   where user_id = '00000000-0000-4000-8000-000000000003' and symbol = 'PLGTEST';
  select invested_removed_micro into v_removed from public.equity_sales
   where user_id = '00000000-0000-4000-8000-000000000003' and symbol = 'PLGTEST'
   order by created_at desc limit 1;
  -- 1 of 10 shares sold, so a tenth of ₦100,000 comes off and is remembered.
  insert into r values (2, 'selling a tenth removes a tenth of the cost basis',
    format('shares %s, cost %s, removed %s', v_shares, v_cost, v_removed),
    v_shares = 9 and v_cost = 90000 * 1000000::bigint and v_removed = 10000 * 1000000::bigint);
end $$;

-- 3. THE POINT: pledge it, and the sell is refused.
do $$
declare v_sale bigint; v_loan uuid := gen_random_uuid();
begin
  update public.portfolio_holdings set pledged_loan_id = v_loan
   where user_id = '00000000-0000-4000-8000-000000000003' and symbol = 'PLGTEST';

  set local role authenticated;
  set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';
  v_sale := public.place_equity_sell('00000000-0000-4000-8000-000000000003', 'PLGTEST', 'base_dex', 1);
  reset role;
  insert into r values (3, 'a pledged holding cannot be sold', 'ALLOWED, sale '||v_sale::text, false);
exception when others then
  reset role;
  insert into r values (3, 'a pledged holding cannot be sold', left(sqlerrm,70),
    sqlerrm like '%pledged as loan collateral%');
end $$;

-- 4. And the refusal changed nothing: shares and basis are exactly as they were.
do $$
declare v_shares numeric; v_cost bigint;
begin
  select shares, invested_cngn_micro into v_shares, v_cost from public.portfolio_holdings
   where user_id = '00000000-0000-4000-8000-000000000003' and symbol = 'PLGTEST';
  insert into r values (4, 'the refused sell left the position untouched',
    format('shares %s, cost %s', v_shares, v_cost),
    v_shares = 9 and v_cost = 90000 * 1000000::bigint);
end $$;

-- 5. Releasing the pledge, as repay_loan does, makes it sellable again. Frozen, not forfeited.
do $$
declare v_sale bigint;
begin
  update public.portfolio_holdings set pledged_loan_id = null
   where user_id = '00000000-0000-4000-8000-000000000003' and symbol = 'PLGTEST';

  set local role authenticated;
  set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';
  v_sale := public.place_equity_sell('00000000-0000-4000-8000-000000000003', 'PLGTEST', 'base_dex', 1);
  reset role;
  insert into r values (5, 'repaying the loan makes it sellable again', 'sale '||v_sale::text,
    v_sale is not null);
exception when others then
  reset role;
  insert into r values (5, 'repaying the loan makes it sellable again', 'REFUSED: '||left(sqlerrm,70), false);
end $$;

-- 6. 088's provider gate survived. Anything but base_dex is refused.
do $$
declare v_sale bigint;
begin
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';
  v_sale := public.place_equity_sell('00000000-0000-4000-8000-000000000003', 'PLGTEST', 'getequity', 1);
  reset role;
  insert into r values (6, 'a non-base_dex provider is still refused', 'ALLOWED', false);
exception when others then
  reset role;
  insert into r values (6, 'a non-base_dex provider is still refused', left(sqlerrm,60),
    sqlerrm like '%cannot be sold in the app yet%');
end $$;

-- 7. 088's asset_type gate survived. An RWA holding is refused even under base_dex.
do $$
declare v_sale bigint;
begin
  insert into public.portfolio_holdings
    (user_id, symbol, asset_type, provider, invested_cngn_micro, shares)
  values
    ('00000000-0000-4000-8000-000000000003', 'RWATEST', 'rwa', 'base_dex',
     100000 * 1000000::bigint, 10);

  set local role authenticated;
  set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';
  v_sale := public.place_equity_sell('00000000-0000-4000-8000-000000000003', 'RWATEST', 'base_dex', 1);
  reset role;
  insert into r values (7, 'an RWA holding is still refused', 'ALLOWED', false);
exception when others then
  reset role;
  insert into r values (7, 'an RWA holding is still refused', left(sqlerrm,60),
    sqlerrm like '%cannot be sold in the app yet%');
end $$;

-- 8. 098's identity gate survived. ...006 has no BVN onboarding and no VA number.
do $$
declare v_sale bigint; v_kyc text; v_onb text; v_va text;
begin
  select kyc_status, strails_onboard_status, coalesce(strails_va_account_number,'')
    into v_kyc, v_onb, v_va from public.profiles
   where id = '00000000-0000-4000-8000-000000000006';

  insert into public.portfolio_holdings
    (user_id, symbol, asset_type, provider, invested_cngn_micro, shares)
  values
    ('00000000-0000-4000-8000-000000000006', 'PLGTEST', 'tokenized_stock', 'base_dex',
     100000 * 1000000::bigint, 10)
  on conflict (user_id, symbol, provider) do update set shares = 10, pledged_loan_id = null;

  set local role authenticated;
  set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000006","role":"authenticated"}';
  v_sale := public.place_equity_sell('00000000-0000-4000-8000-000000000006', 'PLGTEST', 'base_dex', 1);
  reset role;
  -- If ...006 happens to be onboarded in the seed then this proves nothing, so say so instead of
  -- reporting a pass.
  insert into r values (8, 'an unverified user is still refused',
    format('ALLOWED (kyc=%s onboard=%s va=%s)', v_kyc, v_onb, case when v_va = '' then 'none' else 'set' end),
    false);
exception when others then
  reset role;
  insert into r values (8, 'an unverified user is still refused', left(sqlerrm,60),
    sqlerrm like '%identity not verified%');
end $$;

-- 9. Somebody else's holding is not sellable by you.
do $$
declare v_sale bigint;
begin
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';
  v_sale := public.place_equity_sell('00000000-0000-4000-8000-000000000006', 'PLGTEST', 'base_dex', 1);
  reset role;
  insert into r values (9, 'selling another user''s holding is refused', 'ALLOWED', false);
exception when others then
  reset role;
  insert into r values (9, 'selling another user''s holding is refused', left(sqlerrm,60),
    sqlerrm like '%unauthorized%');
end $$;

-- Tidy up.
delete from public.equity_sales where symbol in ('PLGTEST', 'RWATEST');
delete from public.portfolio_holdings where symbol in ('PLGTEST', 'RWATEST');

select ord, name, detail, case when ok then 'PASS' else 'FAIL' end as result
from r order by ord;
