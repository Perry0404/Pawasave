--
-- STAGING ONLY. Modifies data. Proves a circle owner cannot write their own pot, and that creating a
-- circle from a browser still works.
--
-- The attack this closes, end to end: contribute ₦1,000 for real, then UPDATE pot_balance_kobo to
-- ₦50,000, then call process_esusu_payout and collect ₦49,000 of cNGN nobody funded.
--
-- Depends on seed-staging-users.sql. Uses ...003, who has identity and a funded wallet.

create temp table if not exists r (ord int, name text, detail text, ok boolean);
delete from r;
-- The role-switching blocks below write to this, so it has to be reachable from `authenticated`.
grant all on r to authenticated;

-- 1. THE MINT, attempted. The owner contributes honestly, then inflates the pot.
do $$
declare g uuid; m uuid; w0 bigint; w1 bigint; pot bigint; res jsonb; err text := null;
begin
  delete from public.esusu_groups where name = '112 mint probe';
  insert into public.esusu_groups (name, owner_id, circle_type, payout_mode, status, cycle_period,
    contribution_amount_kobo, max_members, current_cycle, creator_incentive_percent)
  values ('112 mint probe','00000000-0000-4000-8000-000000000003','rotating_ajo','rotating','active',
    'weekly',100000,1,1,0) returning id into g;
  insert into public.esusu_members (group_id, user_id, payout_position)
  values (g,'00000000-0000-4000-8000-000000000003',1) returning id into m;

  update public.wallets set usdc_balance_micro = 50000 * 1000000::bigint
   where user_id = '00000000-0000-4000-8000-000000000003';
  select usdc_balance_micro into w0 from public.wallets
   where user_id = '00000000-0000-4000-8000-000000000003';

  -- The genuine contribution goes in its OWN block. A caught exception rolls a PL/pgSQL block back to
  -- its start, so when this shared a block with the refused UPDATE below, the real contribution was
  -- rolled back too and the pot read zero — making assertion 2 look like a bug in the migration.
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';
  perform public.esusu_contribute('00000000-0000-4000-8000-000000000003', g, m, 100000, 1);
  reset role;

  begin
    set local role authenticated;
    set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';
    update public.esusu_groups set pot_balance_kobo = 5000000 where id = g;
    reset role;
  exception when others then
    reset role; err := sqlerrm;
  end;

  select pot_balance_kobo into pot from public.esusu_groups where id = g;

  insert into r values (1, 'the owner cannot write the pot from a browser',
    coalesce('refused: ' || left(err, 58), 'ALLOWED — pot is now ' || (pot/100)::text || ' NGN'),
    err is not null);

  -- 2. And the pot still holds exactly what was genuinely contributed: ₦1,000 less the 0.5%
  --    penalty, 95% of which goes to the pot and 5% to the emergency pot.
  insert into r values (2, 'the pot holds only the real contribution',
    (pot/100.0)::text || ' NGN, expected 945.25', pot = 94525);

  -- 3. A payout now pays the real pot, not an invented one.
  begin
    set local role authenticated;
    set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';
    res := public.process_esusu_payout(g);
    reset role;
  exception when others then
    reset role;
  end;

  select usdc_balance_micro into w1 from public.wallets
   where user_id = '00000000-0000-4000-8000-000000000003';

  -- Paid in ₦1,000, got back ₦945.25. Down by the penalty and the emergency-pot share, which is what
  -- the product says happens. The point is that it is a loss, not a ₦49,000 profit.
  insert into r values (3, 'the payout cannot exceed what was contributed',
    'wallet change ' || ((w1 - w0) / 10000.0)::text || ' NGN, payout ' || coalesce(res::text,'(none)'),
    (w1 - w0) <= 0);

  delete from public.esusu_groups where id = g;
end $$;

-- 4. DELETE is gone too. Dropping the circle would have stranded everyone's contributions.
do $$
declare g uuid; still int; err text := null;
begin
  delete from public.esusu_groups where name = '112 delete probe';
  insert into public.esusu_groups (name, owner_id, circle_type, payout_mode, status, cycle_period,
    contribution_amount_kobo, max_members, current_cycle)
  values ('112 delete probe','00000000-0000-4000-8000-000000000003','rotating_ajo','rotating','active',
    'weekly',100000,2,1) returning id into g;

  begin
    set local role authenticated;
    set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';
    delete from public.esusu_groups where id = g;
    reset role;
  exception when others then
    reset role; err := sqlerrm;
  end;

  select count(*) into still from public.esusu_groups where id = g;
  insert into r values (4, 'the owner cannot delete the circle',
    case when still = 1 then 'still there' else 'DELETED' end, still = 1);
  delete from public.esusu_groups where id = g;
end $$;

-- 5. Creating a circle from a browser still works. This is the path 100 refused to break, and the
--    reason this migration narrowed the policy rather than dropping it.
do $$
declare g uuid; err text := null;
begin
  delete from public.esusu_groups where name = '112 create probe';
  begin
    set local role authenticated;
    set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';
    -- Exactly the column list groups-view.tsx:117 sends.
    insert into public.esusu_groups
      (name, owner_id, contribution_amount_kobo, cycle_period, max_members, current_cycle,
       creator_incentive_percent, circle_type, payout_mode)
    values ('112 create probe','00000000-0000-4000-8000-000000000003',100000,'weekly',5,0,0,
       'rotating_ajo','rotating')
    returning id into g;
    reset role;
  exception when others then
    reset role; err := sqlerrm;
  end;
  insert into r values (5, 'a browser can still create a circle',
    coalesce('BROKEN: ' || left(err,58), 'created'), err is null and g is not null);
end $$;

-- 6. But not one that already has money in it.
do $$
declare g uuid; err text := null;
begin
  begin
    set local role authenticated;
    set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';
    insert into public.esusu_groups
      (name, owner_id, contribution_amount_kobo, cycle_period, max_members, current_cycle,
       circle_type, payout_mode, pot_balance_kobo)
    values ('112 prefunded','00000000-0000-4000-8000-000000000003',100000,'weekly',5,1,
       'rotating_ajo','rotating', 5000000)
    returning id into g;
    reset role;
  exception when others then
    reset role; err := sqlerrm;
  end;
  insert into r values (6, 'a circle cannot be created with a pot already in it',
    coalesce('refused: ' || left(err,58), 'ALLOWED'), err is not null);
  delete from public.esusu_groups where name = '112 prefunded';
end $$;

-- 7. Nor one with an emergency pot, which disburses by vote and is the same money.
do $$
declare err text := null;
begin
  begin
    set local role authenticated;
    set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';
    insert into public.esusu_groups
      (name, owner_id, contribution_amount_kobo, cycle_period, max_members, circle_type, payout_mode,
       emergency_pot_kobo)
    values ('112 prefunded emergency','00000000-0000-4000-8000-000000000003',100000,'weekly',5,
       'rotating_ajo','rotating', 5000000);
    reset role;
  exception when others then
    reset role; err := sqlerrm;
  end;
  insert into r values (7, 'nor with an emergency pot already in it',
    coalesce('refused: ' || left(err,58), 'ALLOWED'), err is not null);
  delete from public.esusu_groups where name = '112 prefunded emergency';
end $$;

-- 8. The policy set is what it should be: one INSERT policy, reads, and nothing for UPDATE or DELETE.
do $$
declare v_all int; v_upd int; v_del int; v_ins int;
begin
  select count(*) into v_all from pg_policies
   where schemaname='public' and tablename='esusu_groups' and cmd='ALL';
  select count(*) into v_upd from pg_policies
   where schemaname='public' and tablename='esusu_groups' and cmd='UPDATE';
  select count(*) into v_del from pg_policies
   where schemaname='public' and tablename='esusu_groups' and cmd='DELETE';
  select count(*) into v_ins from pg_policies
   where schemaname='public' and tablename='esusu_groups' and cmd='INSERT';
  insert into r values (8, 'no FOR ALL, FOR UPDATE or FOR DELETE policy remains',
    format('all=%s update=%s delete=%s insert=%s', v_all, v_upd, v_del, v_ins),
    v_all = 0 and v_upd = 0 and v_del = 0 and v_ins = 1);
end $$;

-- 9. And no client can WRITE any money or state column.
--
-- SELECT is deliberately not checked: the app reads the pot to show it, which is the whole point of
-- the circle screen. Only INSERT and UPDATE are the hole.
do $$
declare leaked text;
begin
  select string_agg(distinct column_name || '/' || privilege_type, ', ')
    into leaked
    from information_schema.column_privileges
   where table_schema='public' and table_name='esusu_groups'
     and grantee in ('authenticated','anon','PUBLIC')
     and privilege_type in ('INSERT','UPDATE')
     and column_name in ('pot_balance_kobo','emergency_pot_kobo','status','settled_at',
                         'cycle_started_at','beneficiary_id');
  insert into r values (9, 'no client write privilege on any money or state column',
    coalesce(leaked, 'none'), leaked is null);
end $$;

-- Tidy up.
delete from public.esusu_groups
 where name in ('112 mint probe','112 delete probe','112 create probe','112 prefunded',
                '112 prefunded emergency');

select ord, name, detail, case when ok then 'PASS' else 'FAIL' end as result
from r order by ord;
