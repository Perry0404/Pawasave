-- 104_emergency_no_client_insert_behaviour.sql
--
-- STAGING ONLY. Proves a member can no longer hand-write an emergency request or vote, and that the
-- legitimate path through the RPCs still works end to end including the disbursement.
--
-- Depends on seed-staging-users.sql. Builds its own circle, because the emergency pot has to have
-- money in it and none of the seeded fixtures carry one.

create temp table if not exists r (ord int, name text, detail text, ok boolean);
delete from r;

-- A two-member active circle with ₦5,000 in the emergency pot.
do $$
declare v_group uuid;
begin
  delete from public.esusu_groups where name = 'Emergency test circle';
  insert into public.esusu_groups
    (name, owner_id, contribution_amount_kobo, cycle_period, max_members, status,
     circle_type, payout_mode, current_cycle, emergency_pot_kobo)
  values
    ('Emergency test circle', '00000000-0000-4000-8000-000000000001', 500000, 'monthly', 2, 'active',
     'rotating_ajo', 'rotating', 1, 500000)
  returning id into v_group;
  insert into public.esusu_members (group_id, user_id, payout_position)
  values (v_group, '00000000-0000-4000-8000-000000000001', 1),
         (v_group, '00000000-0000-4000-8000-000000000002', 2);
end $$;

-- 1. A member cannot insert a request by hand, which is how the amount ceiling and the
--    one-vote-at-a-time rule were skippable.
do $$
declare msg text; v_group uuid;
begin
  select id into v_group from public.esusu_groups where name = 'Emergency test circle';
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
  begin
    insert into public.emergency_requests (group_id, requester_id, reason, amount_kobo)
    values (v_group, '00000000-0000-4000-8000-000000000001', 'hand written', 99999999);
    msg := 'NO ERROR';
  exception when others then msg := SQLERRM;
  end;
  reset role;
  insert into r values (1, 'a hand-written request is refused', msg, msg <> 'NO ERROR');
exception when others then
  reset role;
  insert into r values (1, 'a hand-written request is refused', 'harness failed: '||SQLERRM, false);
end $$;

-- 2. The RPC path still works, and it is the caller's own membership that admits them.
do $$
declare res jsonb; v_group uuid; v_rows int;
begin
  select id into v_group from public.esusu_groups where name = 'Emergency test circle';
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
  res := public.request_emergency_payout(v_group, 'Hospital bill', 300000);
  reset role;
  select count(*) into v_rows from public.emergency_requests
   where group_id = v_group and status = 'voting';
  insert into r values (2, 'the rpc opens a vote', coalesce(res::text,'null')||' rows '||v_rows,
    (res->>'ok') = 'true' and v_rows = 1);
exception when others then
  reset role;
  insert into r values (2, 'the rpc opens a vote', 'failed: '||SQLERRM, false);
end $$;

-- 3. The amount ceiling is the pot, which a hand-written row would have ignored.
do $$
declare res jsonb; v_group uuid;
begin
  select id into v_group from public.esusu_groups where name = 'Emergency test circle';
  -- Clear the running vote so "already in progress" is not what refuses this.
  update public.emergency_requests set status = 'rejected' where group_id = v_group and status = 'voting';
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
  res := public.request_emergency_payout(v_group, 'Too much', 99999999);
  reset role;
  insert into r values (3, 'more than the pot is refused', coalesce(res::text,'null'),
    (res->>'ok') = 'false' and (res->>'error') like '%emergency pot%');
exception when others then
  reset role;
  insert into r values (3, 'more than the pot is refused', 'failed: '||SQLERRM, false);
end $$;

-- 4. Only one vote runs at a time.
do $$
declare first jsonb; second jsonb; v_group uuid;
begin
  select id into v_group from public.esusu_groups where name = 'Emergency test circle';
  update public.emergency_requests set status = 'rejected' where group_id = v_group and status = 'voting';
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
  first  := public.request_emergency_payout(v_group, 'First', 100000);
  second := public.request_emergency_payout(v_group, 'Second', 100000);
  reset role;
  insert into r values (4, 'a second concurrent vote is refused',
    'first '||(first->>'ok')||', second '||coalesce(second->>'error','(none)'),
    (first->>'ok') = 'true' and (second->>'ok') = 'false'
      and (second->>'error') like '%already in progress%');
exception when others then
  reset role;
  insert into r values (4, 'a second concurrent vote is refused', 'failed: '||SQLERRM, false);
end $$;

-- 5. A member cannot insert a vote by hand. This is the quiet one: a hand-written row is a vote that
--    never triggers a payout, and the unique constraint then blocks the real one.
do $$
declare msg text; v_req uuid;
begin
  select er.id into v_req from public.emergency_requests er
    join public.esusu_groups g on g.id = er.group_id
   where g.name = 'Emergency test circle' and er.status = 'voting' limit 1;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000002","role":"authenticated"}';
  begin
    insert into public.emergency_votes (request_id, voter_id, approve)
    values (v_req, '00000000-0000-4000-8000-000000000002', false);
    msg := 'NO ERROR';
  exception when others then msg := SQLERRM;
  end;
  reset role;
  insert into r values (5, 'a hand-written vote is refused', msg, msg <> 'NO ERROR');
exception when others then
  reset role;
  insert into r values (5, 'a hand-written vote is refused', 'harness failed: '||SQLERRM, false);
end $$;

-- 6. Voting through the RPC reaches a majority and pays out, in cNGN.
do $$
declare v_req uuid; v_group uuid; res jsonb; before bigint; after bigint; v_pot bigint;
begin
  select id into v_group from public.esusu_groups where name = 'Emergency test circle';
  select id into v_req from public.emergency_requests
   where group_id = v_group and status = 'voting' limit 1;
  select usdc_balance_micro into before from public.wallets
   where user_id = '00000000-0000-4000-8000-000000000001';

  -- Two members, so two approvals clear `approve_count > member_count / 2`.
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
  perform public.cast_emergency_vote(v_req, true);
  reset role;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000002","role":"authenticated"}';
  res := public.cast_emergency_vote(v_req, true);
  reset role;

  select usdc_balance_micro into after from public.wallets
   where user_id = '00000000-0000-4000-8000-000000000001';
  select emergency_pot_kobo into v_pot from public.esusu_groups where id = v_group;

  -- ₦1,000 requested: 100000 kobo becomes 1,000,000,000 micro.
  insert into r values (6, 'a majority disburses in cNGN and drains the pot by that much',
    coalesce(res::text,'null')||' | wallet +'||(after - before)||' | pot now '||v_pot,
    (res->>'disbursed') = 'true' and (after - before) = 1000000000);
exception when others then
  reset role;
  insert into r values (6, 'a majority disburses in cNGN and drains the pot by that much',
    'failed: '||SQLERRM, false);
end $$;

-- 7. A non-member cannot vote, even through the RPC.
--
-- Needs a vote that is still open. The request from case 6 was disbursed, and cast_emergency_vote
-- checks the status before it checks membership — so reusing it would pass for the wrong reason.
do $$
declare v_req uuid; v_group uuid; res jsonb;
begin
  select id into v_group from public.esusu_groups where name = 'Emergency test circle';
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
  v_req := (public.request_emergency_payout(v_group, 'Still open', 100000))->>'request_id';
  reset role;

  set local role authenticated;
  set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000004","role":"authenticated"}';
  res := public.cast_emergency_vote(v_req, true);
  reset role;
  insert into r values (7, 'a non-member cannot vote on an open request', coalesce(res::text,'null'),
    (res->>'ok') = 'false' and (res->>'error') like '%Not a member%');
exception when others then
  reset role;
  insert into r values (7, 'a non-member cannot vote on an open request', 'failed: '||SQLERRM, false);
end $$;

-- 8. Members can still read both tables, which is what makes a running vote visible.
do $$
declare mine int; theirs int;
begin
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000002","role":"authenticated"}';
  select count(*) into mine from public.emergency_requests;
  reset role;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000004","role":"authenticated"}';
  select count(*) into theirs from public.emergency_requests;
  reset role;
  insert into r values (8, 'members read their circle''s requests, outsiders read none',
    'member sees '||mine||', outsider sees '||theirs, mine > 0 and theirs = 0);
exception when others then
  reset role;
  insert into r values (8, 'members read their circle''s requests, outsiders read none',
    'failed: '||SQLERRM, false);
end $$;

select ord, name, detail, case when ok then 'PASS' else 'FAIL' end as result
from r order by ord;
