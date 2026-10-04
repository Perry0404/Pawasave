-- 103_circle_invites_behaviour.sql
--
-- STAGING ONLY. Proves a circle invite is a credential with a lifetime, which the old
-- /join/<group uuid> link was not, and that no client can mint or redeem one directly.
--
-- Depends on seed-staging-users.sql: ...001 owns the circle, ...002 and ...003 are invitees.
--
-- Two roles are exercised deliberately. As service_role the functions do their job; as
-- authenticated every one of them is a permission error, because the app reaches them through
-- routes that derive the actor from the bearer. The auth.uid() guards inside them are belt and
-- braces for the day somebody widens a grant.

create temp table if not exists r (ord int, name text, detail text, ok boolean);
delete from r;

-- A fresh circle owned by ...001, two seats, so "full" is reachable.
do $$
declare v_group uuid;
begin
  delete from public.esusu_groups where name = 'Invite test circle';
  insert into public.esusu_groups
    (name, owner_id, contribution_amount_kobo, cycle_period, max_members, status,
     circle_type, payout_mode)
  values
    ('Invite test circle', '00000000-0000-4000-8000-000000000001', 500000, 'monthly', 2, 'forming',
     'rotating_ajo', 'rotating')
  returning id into v_group;
  insert into public.esusu_members (group_id, user_id, payout_position)
  values (v_group, '00000000-0000-4000-8000-000000000001', 1);
end $$;

-- 1. The owner mints a link, and the token is not guessable.
do $$
declare res jsonb; tok text;
begin
  set local role service_role;
  res := public.circle_invite_create(
    (select id from public.esusu_groups where name = 'Invite test circle'),
    '00000000-0000-4000-8000-000000000001', 'the cousins', 168, 0);
  reset role;
  tok := res->>'token';
  insert into r values (1, 'the owner mints a link',
    'token length '||length(tok)||', expires '||(res->>'expires_at'),
    length(tok) = 32 and tok ~ '^[0-9a-f]{32}$' and (res->>'expires_at') is not null);
exception when others then
  reset role;
  insert into r values (1, 'the owner mints a link', 'failed: '||SQLERRM, false);
end $$;

-- 2. Somebody who does not own the circle cannot mint one, even as service_role.
do $$
declare msg text;
begin
  set local role service_role;
  begin
    perform public.circle_invite_create(
      (select id from public.esusu_groups where name = 'Invite test circle'),
      '00000000-0000-4000-8000-000000000002', null, 168, 0);
    msg := 'NO ERROR';
  exception when others then msg := SQLERRM;
  end;
  reset role;
  insert into r values (2, 'only the owner can invite', msg, msg like '%only the circle owner%');
exception when others then
  reset role;
  insert into r values (2, 'only the owner can invite', 'harness failed: '||SQLERRM, false);
end $$;

-- 3. A link that was never issued is a page to render, not an exception.
do $$
declare res jsonb;
begin
  set local role service_role;
  res := public.circle_invite_peek('deadbeefdeadbeefdeadbeefdeadbeef');
  reset role;
  insert into r values (3, 'an unknown token peeks as unknown', res::text,
    (res->>'ok') = 'false' and (res->>'reason') = 'unknown');
exception when others then
  reset role;
  insert into r values (3, 'an unknown token peeks as unknown', 'failed: '||SQLERRM, false);
end $$;

-- 4. Peek says what the circle is and nothing about who is in it.
do $$
declare tok text; res jsonb; leaked boolean;
begin
  select token into tok from public.circle_invites
   where group_id = (select id from public.esusu_groups where name = 'Invite test circle')
   order by created_at desc limit 1;
  set local role service_role;
  res := public.circle_invite_peek(tok);
  reset role;
  -- No owner id, no member list, no pot. A token proves somebody sent you a link.
  leaked := (res ? 'owner_id') or (res ? 'members') or (res ? 'pot_balance_kobo')
         or (res::text like '%00000000-0000-4000-8000-000000000001%');
  insert into r values (4, 'peek describes the circle without naming anyone',
    'keys '||(select string_agg(k, ',' order by k) from jsonb_object_keys(res) k),
    (res->>'ok') = 'true' and (res->>'name') = 'Invite test circle'
      and (res->>'member_count') = '1' and (res->>'max_members') = '2' and not leaked);
exception when others then
  reset role;
  insert into r values (4, 'peek describes the circle without naming anyone', 'failed: '||SQLERRM, false);
end $$;

-- 5. Redeeming joins, records the use, and gives a payout position.
do $$
declare tok text; res jsonb; v_uses int; v_member int;
begin
  select token into tok from public.circle_invites
   where group_id = (select id from public.esusu_groups where name = 'Invite test circle')
   order by created_at desc limit 1;
  set local role service_role;
  res := public.circle_invite_redeem(tok, '00000000-0000-4000-8000-000000000002');
  reset role;
  select uses into v_uses from public.circle_invites where token = tok;
  select count(*) into v_member from public.esusu_members
   where group_id = (select id from public.esusu_groups where name = 'Invite test circle')
     and user_id = '00000000-0000-4000-8000-000000000002';
  insert into r values (5, 'redeeming joins and counts the use',
    'joined '||(res->>'joined')||', position '||(res->>'position')||', uses '||v_uses||', rows '||v_member,
    (res->>'ok') = 'true' and (res->>'joined') = 'true' and (res->>'position') = '2'
      and v_uses = 1 and v_member = 1);
exception when others then
  reset role;
  insert into r values (5, 'redeeming joins and counts the use', 'failed: '||SQLERRM, false);
end $$;

-- 6. Forwarding the link to somebody already in does not cost the circle a use.
do $$
declare tok text; res jsonb; v_uses int;
begin
  select token into tok from public.circle_invites
   where group_id = (select id from public.esusu_groups where name = 'Invite test circle')
   order by created_at desc limit 1;
  set local role service_role;
  res := public.circle_invite_redeem(tok, '00000000-0000-4000-8000-000000000002');
  reset role;
  select uses into v_uses from public.circle_invites where token = tok;
  -- The circle is full by now, which is the point: a member tapping their own link must be told
  -- they are already in it, not that the circle is full.
  insert into r values (6, 'an existing member is told so, not that the circle is full',
    coalesce(res::text, 'null'),
    (res->>'ok') = 'true' and (res->>'joined') = 'false'
      and (res->>'reason') = 'already_member' and v_uses = 1);
exception when others then
  reset role;
  insert into r values (6, 'an existing member does not burn a use', 'harness failed: '||SQLERRM, false);
end $$;

-- 7. The second join filled the circle, so the same link now reads as full.
do $$
declare tok text; peeked jsonb; redeemed jsonb;
begin
  select token into tok from public.circle_invites
   where group_id = (select id from public.esusu_groups where name = 'Invite test circle')
   order by created_at desc limit 1;
  set local role service_role;
  peeked   := public.circle_invite_peek(tok);
  redeemed := public.circle_invite_redeem(tok, '00000000-0000-4000-8000-000000000003');
  reset role;
  insert into r values (7, 'a full circle turns the link away',
    'peek '||(peeked->>'reason')||', redeem '||(redeemed->>'reason'),
    (peeked->>'ok') = 'false' and (peeked->>'reason') = 'full'
      and (redeemed->>'ok') = 'false' and (redeemed->>'reason') = 'full');
exception when others then
  reset role;
  insert into r values (7, 'a full circle turns the link away', 'failed: '||SQLERRM, false);
end $$;

-- 8. An expired link is dead, which the group-id link never was.
do $$
declare tok text; peeked jsonb; redeemed jsonb; v_group uuid;
begin
  select id into v_group from public.esusu_groups where name = 'Invite test circle';
  -- Room for one more, so "full" cannot be the reason it is refused.
  update public.esusu_groups set max_members = 5 where id = v_group;
  set local role service_role;
  tok := (public.circle_invite_create(v_group, '00000000-0000-4000-8000-000000000001',
                                      null, 1, 0))->>'token';
  reset role;
  update public.circle_invites set expires_at = now() - interval '1 minute' where token = tok;
  set local role service_role;
  peeked   := public.circle_invite_peek(tok);
  redeemed := public.circle_invite_redeem(tok, '00000000-0000-4000-8000-000000000003');
  reset role;
  insert into r values (8, 'an expired link is dead',
    'peek '||(peeked->>'reason')||', redeem '||(redeemed->>'reason'),
    (peeked->>'reason') = 'expired' and (redeemed->>'reason') = 'expired');
exception when others then
  reset role;
  insert into r values (8, 'an expired link is dead', 'failed: '||SQLERRM, false);
end $$;

-- 9. A revoked link is dead, and only the owner can revoke it.
do $$
declare tok text; v_group uuid; revoked boolean; wrong text; redeemed jsonb;
begin
  select id into v_group from public.esusu_groups where name = 'Invite test circle';
  set local role service_role;
  tok := (public.circle_invite_create(v_group, '00000000-0000-4000-8000-000000000001',
                                      null, 168, 0))->>'token';
  begin
    perform public.circle_invite_revoke(tok, '00000000-0000-4000-8000-000000000002');
    wrong := 'NO ERROR';
  exception when others then wrong := SQLERRM;
  end;
  revoked  := public.circle_invite_revoke(tok, '00000000-0000-4000-8000-000000000001');
  redeemed := public.circle_invite_redeem(tok, '00000000-0000-4000-8000-000000000003');
  reset role;
  insert into r values (9, 'only the owner revokes, and a revoked link is dead',
    'non-owner: '||wrong||' | revoked '||revoked::text||' | redeem '||(redeemed->>'reason'),
    wrong like '%only the circle owner%' and revoked and (redeemed->>'reason') = 'revoked');
exception when others then
  reset role;
  insert into r values (9, 'only the owner revokes, and a revoked link is dead', 'failed: '||SQLERRM, false);
end $$;

-- 10. A capped link runs out rather than working forever.
do $$
declare tok text; v_group uuid; first jsonb; peeked jsonb;
begin
  select id into v_group from public.esusu_groups where name = 'Invite test circle';
  set local role service_role;
  tok   := (public.circle_invite_create(v_group, '00000000-0000-4000-8000-000000000001',
                                        null, 168, 1))->>'token';
  first := public.circle_invite_redeem(tok, '00000000-0000-4000-8000-000000000003');
  peeked := public.circle_invite_peek(tok);
  reset role;
  insert into r values (10, 'a one-use link is spent after one join',
    'first joined '||(first->>'joined')||', then '||(peeked->>'reason'),
    (first->>'joined') = 'true' and (peeked->>'ok') = 'false' and (peeked->>'reason') = 'used_up');
exception when others then
  reset role;
  insert into r values (10, 'a one-use link is spent after one join', 'failed: '||SQLERRM, false);
end $$;

-- 11. None of the four is reachable from a client. This is the real boundary; the auth.uid()
--     checks inside them are for the day somebody widens a grant by accident.
do $$
declare n int := 0; blocked int := 0; msg text; v_group uuid;
begin
  select id into v_group from public.esusu_groups where name = 'Invite test circle';
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
  begin n := n+1; perform public.circle_invite_create(v_group, '00000000-0000-4000-8000-000000000001');
  exception when insufficient_privilege then blocked := blocked+1; when others then null; end;
  begin n := n+1; perform public.circle_invite_peek('x');
  exception when insufficient_privilege then blocked := blocked+1; when others then null; end;
  begin n := n+1; perform public.circle_invite_redeem('x', '00000000-0000-4000-8000-000000000001');
  exception when insufficient_privilege then blocked := blocked+1; when others then null; end;
  begin n := n+1; perform public.circle_invite_revoke('x', '00000000-0000-4000-8000-000000000001');
  exception when insufficient_privilege then blocked := blocked+1; when others then null; end;
  reset role;
  insert into r values (11, 'no client can mint, peek, redeem or revoke',
    blocked||' of '||n||' refused', blocked = n);
exception when others then
  reset role;
  insert into r values (11, 'no client can mint, peek, redeem or revoke', 'harness failed: '||SQLERRM, false);
end $$;

-- 12. A member can read their own circle's invites; an outsider cannot.
do $$
declare mine int; theirs int;
begin
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
  select count(*) into mine from public.circle_invites;
  reset role;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000004","role":"authenticated"}';
  select count(*) into theirs from public.circle_invites;
  reset role;
  insert into r values (12, 'members read their own invites, outsiders read none',
    'member sees '||mine||', outsider sees '||theirs, mine > 0 and theirs = 0);
exception when others then
  reset role;
  insert into r values (12, 'members read their own invites, outsiders read none', 'failed: '||SQLERRM, false);
end $$;

select ord, name, detail, case when ok then 'PASS' else 'FAIL' end as result
from r order by ord;
