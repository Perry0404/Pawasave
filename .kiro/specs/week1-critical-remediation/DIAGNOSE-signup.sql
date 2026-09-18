-- Diagnose signup after enabling RLS on wallets and profiles.
--
-- Question: is handle_new_user still creating the profile and wallet rows?
--
-- Read-only, single result set. Run the whole file.
--
-- Note on approach: an earlier version probed by inserting a row with a random
-- uuid. That was wrong. profiles.id is a foreign key to auth.users, so the insert
-- would fail on the FK and look like an RLS block. This reads the catalogs and the
-- real signup history instead.

with recent as (
  select
    u.id,
    u.email,
    u.created_at,
    (p.id is not null)      as has_profile,
    (w.user_id is not null) as has_wallet
  from auth.users u
  left join public.profiles p on p.id = u.id
  left join public.wallets  w on w.user_id = u.id
  order by u.created_at desc
  limit 10
),

-- Owner of handle_new_user, and whether that owner escapes RLS.
-- A table owner bypasses RLS unless FORCE ROW LEVEL SECURITY is set, so if the
-- function owner also owns the tables the trigger is unaffected by the hotfix.
fn as (
  select
    pg_get_userbyid(p.proowner)::text as fn_owner,
    p.prosecdef                       as is_definer,
    r.rolbypassrls                    as owner_bypassrls,
    r.rolsuper                        as owner_super
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_roles r     on r.oid = p.proowner
  where n.nspname = 'public' and p.proname = 'handle_new_user'
  limit 1
),
tbl as (
  select
    max(pg_get_userbyid(c.relowner)::text) filter (where c.relname = 'profiles') as profiles_owner,
    max(pg_get_userbyid(c.relowner)::text) filter (where c.relname = 'wallets')  as wallets_owner,
    bool_or(c.relforcerowsecurity)                                               as any_forced
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname in ('profiles', 'wallets')
),

-- Counts split either side of the hotfix. Kept as its own CTE so the bucket is a
-- named column rather than a GROUP BY ordinal.
totals as (
  select
    case when u.created_at > now() - interval '3 hours' then 'last 3 hours' else 'older' end as bucket,
    count(*)                    as users,
    count(*) - count(p.id)      as missing_profile,
    count(*) - count(w.user_id) as missing_wallet
  from auth.users u
  left join public.profiles p on p.id = u.id
  left join public.wallets  w on w.user_id = u.id
  group by 1
),

report as (

  -- 1. Verdict first, this is the answer
  select 1 as ord, '1. VERDICT' as section,
    case
      when (select count(*) from recent where not has_profile or not has_wallet) = 0
        then 'Signup is fine. Every recent user has a profile and a wallet.'
      when (select count(*) from recent where created_at > now() - interval '3 hours'
              and (not has_profile or not has_wallet)) > 0
        then 'BROKEN since the hotfix. Recent users are missing rows, see section 2.'
      else 'Older users are missing rows but recent ones are fine. Pre-existing, not the hotfix.'
    end as item,
    '' as value

  -- 2. Last 10 signups
  union all
  select 2, '2. Recent signups',
    coalesce(email, id::text) || '  (' || to_char(created_at, 'DD Mon HH24:MI') || ')',
    case when has_profile and has_wallet then 'ok'
         when has_profile then 'MISSING WALLET'
         when has_wallet  then 'MISSING PROFILE'
         else 'MISSING BOTH' end
  from recent

  -- 3. Aggregate, splits the hotfix window from everything before it
  union all
  select 3, '3. Totals', bucket,
    users::text || ' users, '
      || missing_profile::text || ' missing profile, '
      || missing_wallet::text  || ' missing wallet'
  from totals

  -- 4. Why, in catalog terms
  union all
  select 4, '4. Trigger vs RLS', 'handle_new_user owner',
    fn_owner || case when is_definer then ' (SECURITY DEFINER)' else ' (INVOKER)' end
  from fn
  union all
  select 4, '4. Trigger vs RLS', 'profiles / wallets owner',
    profiles_owner || ' / ' || wallets_owner from tbl
  union all
  select 4, '4. Trigger vs RLS', 'owner escapes RLS',
    case
      when (select owner_bypassrls or owner_super from fn) then 'yes, role has BYPASSRLS or is superuser'
      when (select fn_owner from fn) = (select profiles_owner from tbl)
       and (select fn_owner from fn) = (select wallets_owner from tbl)
       and not (select any_forced from tbl)
        then 'yes, owns both tables and neither forces RLS'
      else 'NO, the trigger is subject to RLS and this is likely the cause'
    end
  union all
  select 4, '4. Trigger vs RLS', 'FORCE ROW LEVEL SECURITY set',
    case when (select any_forced from tbl) then 'yes, this defeats owner bypass' else 'no' end

  -- 5. The insert policies the trigger relies on if it is subject to RLS
  union all
  select 5, '5. INSERT policies', tablename::text || ' :: ' || policyname::text,
    coalesce(with_check, '(none)')
  from pg_policies
  where schemaname = 'public' and tablename in ('profiles', 'wallets') and cmd = 'INSERT'
)

select section, item, value
from report
order by ord, item;
