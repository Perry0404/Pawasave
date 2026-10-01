-- VERIFY-migrations-applied.sql
--
-- READ ONLY. One query. Paste into the Supabase SQL editor and read the result column.
--
-- Checks the observable effect of each migration rather than trusting a filename, because a
-- migration can be "run" and still not be in force: 105 fails by design when duplicate rows exist,
-- and a failed CREATE INDEX leaves no trace behind it.
--
-- Anything reading NOT APPLIED needs attention. Anything reading CHECK needs a human.

with checks as (

  -- 103: tokenised circle invites
  select 1 as ord, '103 circle invites' as migration,
    case when exists (
      select 1 from information_schema.tables
       where table_schema='public' and table_name='circle_invites'
    ) then 'applied' else 'NOT APPLIED' end as result,
    'table circle_invites' as evidence

  -- 104: no client writes to the emergency vote tables
  union all select 2, '104 emergency no client insert',
    case when not exists (
      select 1 from pg_policies
       where schemaname='public' and tablename in ('emergency_requests','emergency_votes')
         and cmd in ('INSERT','ALL')
    ) then 'applied' else 'NOT APPLIED' end,
    coalesce((select string_agg(tablename||'/'||cmd||'/'||policyname, '; ')
              from pg_policies
              where schemaname='public' and tablename in ('emergency_requests','emergency_votes')
                and cmd in ('INSERT','ALL')), 'no insert policy on either table')

  -- 105: one contribution per member per rotating cycle. THE ONE THAT FAILS ON BAD DATA.
  union all select 3, '105 one contribution per cycle',
    case when exists (
      select 1 from pg_indexes
       where schemaname='public' and indexname='esusu_contributions_one_per_cycle'
    ) then 'applied' else 'NOT APPLIED — it refuses while duplicates exist' end,
    coalesce((select indexdef from pg_indexes
              where schemaname='public' and indexname='esusu_contributions_one_per_cycle'),
             'index absent')

  -- 106: completing a goal pays principal, mints no interest
  union all select 4, '106 goal completion principal only',
    case when exists (
      select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='complete_savings_goal'
         and pg_get_functiondef(p.oid) ilike '%principal%'
    ) then 'applied' else 'CHECK the function body by hand' end,
    'complete_savings_goal mentions principal'

  -- 109: a pledged holding cannot be sold
  union all select 5, '109 block pledged equity sell',
    case when exists (
      select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='place_equity_sell'
         and pg_get_functiondef(p.oid) like '%pledged as loan collateral%'
    ) then 'applied' else 'NOT APPLIED' end,
    'place_equity_sell raises on pledged_loan_id'

  -- 110: the invest identity gate fires on a NULL column
  union all select 6, '110 invest identity null safe',
    case when exists (
      select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='has_invest_identity'
    ) and (select public.has_invest_identity('00000000-0000-0000-0000-000000000000')) is false
    then 'applied' else 'NOT APPLIED' end,
    'has_invest_identity exists and answers false, not NULL, for an unknown user'

  -- 110b: and all three callers actually use it
  union all select 7, '110 all three gates use the helper',
    case when (
      select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public'
         and p.proname in ('place_equity_order','place_equity_sell','place_getequity_order')
         and pg_get_functiondef(p.oid) like '%has_invest_identity%'
    ) = 3 then 'applied' else 'NOT APPLIED — one gate still has the old NULL-unsafe check' end,
    (select count(*)::text || ' of 3 call has_invest_identity'
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public'
        and p.proname in ('place_equity_order','place_equity_sell','place_getequity_order')
        and pg_get_functiondef(p.oid) like '%has_invest_identity%')

  -- 112: THE MINT. No FOR ALL policy, and no client write on the pot.
  union all select 8, '112 owner cannot write the pot',
    case when not exists (
      select 1 from pg_policies
       where schemaname='public' and tablename='esusu_groups' and cmd in ('ALL','UPDATE')
    ) and not exists (
      select 1 from information_schema.column_privileges
       where table_schema='public' and table_name='esusu_groups'
         and grantee in ('authenticated','anon','PUBLIC')
         and privilege_type in ('INSERT','UPDATE')
         and column_name in ('pot_balance_kobo','emergency_pot_kobo','status')
    ) then 'applied' else 'NOT APPLIED — THE MINT IS STILL OPEN' end,
    coalesce((select string_agg(distinct cmd||'/'||policyname,'; ') from pg_policies
              where schemaname='public' and tablename='esusu_groups' and cmd in ('ALL','UPDATE')),
             'no ALL or UPDATE policy')

  -- Parallel work, listed so the picture is complete. Not mine; included because a half-applied
  -- chat feature looks like a broken app rather than a missing migration.
  union all select 9, '107 chat gif/sticker kinds',
    case when exists (
      select 1 from information_schema.check_constraints cc
       join information_schema.constraint_column_usage u on u.constraint_name = cc.constraint_name
       where u.table_name='chat_messages' and cc.check_clause ilike '%sticker%'
    ) then 'applied' else 'CHECK — the app can post stickers, so this needs to be in force' end,
    'a chat_messages kind constraint mentioning sticker'

  union all select 10, '108 p2p attachment',
    case when exists (
      select 1 from information_schema.columns
       where table_schema='public' and table_name='p2p_transfers'
         and column_name='attachment_url'
    ) then 'applied' else 'CHECK — /api/p2p/send accepts an attachment, so this needs to be in force' end,
    'p2p_transfers.attachment_url'

  union all select 11, '111 resolve_contacts',
    case when exists (
      select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='resolve_contacts'
    ) then 'applied' else 'CHECK — /api/p2p/contacts calls this' end,
    'function resolve_contacts'

  -- The data question 105 was blocked on. Should be zero now.
  union all select 12, 'duplicate contributions remaining',
    case when (
      select count(*) from (
        select 1 from public.esusu_contributions
        where cycle_number > 0
        group by group_id, member_id, cycle_number
        having count(*) > 1
      ) x
    ) = 0 then 'clean' else 'STILL PRESENT' end,
    (select count(*)::text || ' duplicated (circle, member, cycle) groups' from (
       select 1 from public.esusu_contributions
       where cycle_number > 0
       group by group_id, member_id, cycle_number
       having count(*) > 1
     ) y)

  -- Fabricated rows, by the net-vs-gross tell. Should also be zero.
  union all select 13, 'client-inserted contributions remaining',
    case when (
      select count(*) from public.esusu_contributions c
      join public.esusu_groups g on g.id = c.group_id
      where c.cycle_number > 0 and c.amount_kobo = g.contribution_amount_kobo
    ) = 0 then 'clean' else 'STILL PRESENT' end,
    (select count(*)::text || ' rows recording the gross amount, so not written by the RPC'
       from public.esusu_contributions c
       join public.esusu_groups g on g.id = c.group_id
      where c.cycle_number > 0 and c.amount_kobo = g.contribution_amount_kobo)

  -- THE MONEY QUESTION that was never answered. A payout out of a fabricated pot is minted cNGN.
  union all select 14, 'cNGN paid out of circles',
    case when (
      select count(*) from public.transactions
       where type in ('esusu_payout','creator_incentive')
    ) = 0 then 'none ever' else 'CHECK each one against funded contributions' end,
    (select coalesce(count(*)::text || ' payouts totalling ₦'
            || to_char(sum(amount_kobo)/100.0, 'FM999999999990.00'), '0')
       from public.transactions where type in ('esusu_payout','creator_incentive'))
)
select ord, migration, result, evidence from checks order by ord;
