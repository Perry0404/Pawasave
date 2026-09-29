-- client_reads_behaviour.sql
--
-- Runs every column list the Flutter client reads directly, against the real schema.
--
-- This exists because of a bug that no test could catch. The circle ledger asked for
-- `esusu_contributions.created_at`; the column is `paid_at`. Nothing failed: widget tests override
-- the ledger provider, Supabase is not faked anywhere in the app's suite, and `flutter analyze` has
-- no idea what a Postgres column is. The only thing that would have noticed is a real device.
--
-- So the check has to live on this side of the boundary. The app reads Postgres directly under RLS —
-- that is the documented posture and the reason there is no /api/circles/list — which means the
-- column lists in `lib/src/data/*_repository.dart` are a contract with this schema, written in a
-- language that cannot see it.
--
-- KEEPING THIS IN SYNC IS MANUAL. When a repository's column list changes, change it here. A column
-- list is a small thing to duplicate and a silent failed read on somebody's phone is not.
--
-- Each block mirrors one named constant. Where a constant exists, it is quoted in the comment so the
-- two can be diffed by eye.

create temp table if not exists r (ord int, name text, detail text, ok boolean);
delete from r;

-- 1. ActivityRepository.balanceColumns
--    'usdc_balance_micro, cngn_pool_micro, cngn_yield_earned_micro'
do $$
begin
  perform usdc_balance_micro, cngn_pool_micro, cngn_yield_earned_micro from public.wallets limit 0;
  insert into r values (1, 'wallets: the balance columns', 'all three resolve', true);
exception when others then
  insert into r values (1, 'wallets: the balance columns', SQLERRM, false);
end $$;

-- 2. ActivityRepository p2p feed
do $$
begin
  perform id, sender_id, recipient_id, recipient_email, amount_micro, note, status, created_at
    from public.p2p_transfers limit 0;
  insert into r values (2, 'p2p_transfers: the activity feed', 'resolves', true);
exception when others then
  insert into r values (2, 'p2p_transfers: the activity feed', SQLERRM, false);
end $$;

-- 3. WalletRepository.hasPin
do $$
begin
  perform pin_set_at from public.profiles limit 0;
  insert into r values (3, 'profiles: pin state', 'resolves', true);
exception when others then
  insert into r values (3, 'profiles: pin state', SQLERRM, false);
end $$;

-- 4. SupabaseProfileRepository
do $$
begin
  perform display_name, tag from public.profiles limit 0;
  insert into r values (4, 'profiles: own profile', 'resolves', true);
exception when others then
  insert into r values (4, 'profiles: own profile', SQLERRM, false);
end $$;

-- 5. CircleRepository._circleColumns
do $$
begin
  perform id, name, owner_id, circle_type, payout_mode, status, cycle_period,
          contribution_amount_kobo, pot_balance_kobo, emergency_pot_kobo, max_members,
          current_cycle, creator_incentive_percent, purpose, goal_kobo, deadline,
          beneficiary_id, cycle_started_at, settled_at
    from public.esusu_groups limit 0;
  insert into r values (5, 'esusu_groups: a circle', 'resolves', true);
exception when others then
  insert into r values (5, 'esusu_groups: a circle', SQLERRM, false);
end $$;

-- 6. CircleRepository._memberColumns
do $$
begin
  perform id, group_id, user_id, payout_position, missed_strikes, removed, has_collected,
          amount_owed_kobo
    from public.esusu_members limit 0;
  insert into r values (6, 'esusu_members: the roster', 'resolves', true);
exception when others then
  insert into r values (6, 'esusu_members: the roster', SQLERRM, false);
end $$;

-- 7. CircleRepository.contributionColumns — THE ONE THAT WAS WRONG.
--    'id, member_id, cycle_number, amount_kobo, paid_at'
do $$
begin
  perform id, member_id, cycle_number, amount_kobo, paid_at
    from public.esusu_contributions limit 0;
  insert into r values (7, 'esusu_contributions: the in-circle ledger', 'resolves', true);
exception when others then
  insert into r values (7, 'esusu_contributions: the in-circle ledger', SQLERRM, false);
end $$;

-- 7b. And the column it used to ask for is genuinely absent, so the guard is not vacuous.
do $$
declare found boolean;
begin
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'esusu_contributions'
      and column_name = 'created_at'
  ) into found;
  insert into r values (8, 'esusu_contributions has no created_at, which is why 7 matters',
    case when found then 'created_at EXISTS — this guard proves nothing' else 'absent, as expected' end,
    not found);
end $$;

-- 9. CircleRepository.openEmergencyRequest
do $$
begin
  perform id, group_id, requester_id, reason, amount_kobo, status, created_at
    from public.emergency_requests limit 0;
  perform voter_id, approve from public.emergency_votes limit 0;
  insert into r values (9, 'emergency requests and votes', 'both resolve', true);
exception when others then
  insert into r values (9, 'emergency requests and votes', SQLERRM, false);
end $$;

-- 10. circle_invites, read by a member to share or revoke a link
do $$
begin
  perform token, group_id, created_by, label, expires_at, max_uses, uses, revoked_at
    from public.circle_invites limit 0;
  insert into r values (10, 'circle_invites: a member''s own links', 'resolves', true);
exception when others then
  insert into r values (10, 'circle_invites: a member''s own links', SQLERRM, false);
end $$;

-- 11. The types the client casts to, for the columns where getting it wrong is a runtime crash
--     rather than a failed read. esusu_contributions.id is a uuid and was being read as a number.
do $$
declare v_type text;
begin
  select data_type into v_type from information_schema.columns
   where table_schema = 'public' and table_name = 'esusu_contributions' and column_name = 'id';
  insert into r values (11, 'esusu_contributions.id is a uuid, not an integer',
    coalesce(v_type,'(missing)'), v_type = 'uuid');
end $$;

select ord, name, detail, case when ok then 'PASS' else 'FAIL' end as result
from r order by ord;
