-- DIAGNOSE-duplicate-contributions.sql
--
-- READ ONLY. Run this against production before deciding what to do about the missing unique
-- constraint on esusu_contributions.
--
-- The problem. There is no unique (group_id, member_id, cycle_number), and esusu_contribute
-- de-duplicates only the `transactions` ledger row — it debits the wallet and inserts the
-- contribution either way. Migration 071's header records a live case: "one member recorded cycle-1
-- five times". Until 100, a client could also insert rows directly with no money moving at all, so
-- there are potentially two kinds of duplicate with opposite meanings:
--
--   PAID TWICE      the member was debited more than once. The pot holds the money.
--   NEVER PAID      a hand-written row with no debit behind it. The pot does not.
--
-- They are told apart by whether a matching `transactions` row exists. esusu_contribute writes the
-- reference `esusu_<group>_<member>_c<cycle>`, and the autodebit cron writes
-- `esusu_autodebit_<group>_<member>_c<cycle>`, so a contribution with no transaction at either
-- reference was very likely written by a browser.
--
-- Why it cannot just be fixed. Deduping changes what `process_esusu_payout` counts, and for the
-- PAID TWICE case the pot legitimately holds the extra money — deleting the row would leave the pot
-- overstated relative to its contributions, and refunding it would take money out of a pot other
-- members are owed from. That is a money decision, not a schema one.
--
-- What to do with the output: if section 1 returns no rows, the constraint can go on as-is and the
-- migration is trivial. If it returns rows, section 3 tells you the money at stake per circle.

\echo '── 1. duplicate (group, member, cycle) groups, rotating cycles only ────────'
-- cycle_number 0 is a collection circle, where many contributions are the whole point.
select
  c.group_id,
  g.name                           as circle,
  g.status,
  c.member_id,
  c.cycle_number,
  count(*)                         as rows,
  sum(c.amount_kobo) / 100.0       as total_ngn,
  min(c.amount_kobo) / 100.0       as smallest_ngn,
  max(c.paid_at)                   as latest
from public.esusu_contributions c
join public.esusu_groups g on g.id = c.group_id
where c.cycle_number > 0
group by c.group_id, g.name, g.status, c.member_id, c.cycle_number
having count(*) > 1
order by count(*) desc, c.group_id;

\echo ''
\echo '── 2. of those, which rows have money behind them ─────────────────────────'
-- A contribution with no transaction at either reference was almost certainly written by a browser
-- and never debited anybody.
with dupes as (
  select c.group_id, c.member_id, c.cycle_number
  from public.esusu_contributions c
  where c.cycle_number > 0
  group by c.group_id, c.member_id, c.cycle_number
  having count(*) > 1
)
select
  c.id,
  c.group_id,
  c.member_id,
  c.cycle_number,
  c.amount_kobo / 100.0 as amount_ngn,
  c.paid_at,
  case
    when t.reference is not null then 'PAID (' || t.reference || ')'
    else 'NO TRANSACTION — probably a client insert'
  end as backing
from public.esusu_contributions c
join dupes d
  on d.group_id = c.group_id and d.member_id = c.member_id and d.cycle_number = c.cycle_number
join public.esusu_members m on m.id = c.member_id
left join public.transactions t
  on t.reference in (
       'esusu_'          || c.group_id::text || '_' || c.member_id::text || '_c' || c.cycle_number::text,
       'esusu_autodebit_'|| c.group_id::text || '_' || c.member_id::text || '_c' || c.cycle_number::text
     )
 and t.user_id = m.user_id
order by c.group_id, c.member_id, c.cycle_number, c.paid_at;

\echo ''
\echo '── 3. money at stake, per circle ──────────────────────────────────────────'
-- `excess_ngn` is what the duplicates add beyond one contribution each. Compare it against the pot:
-- if the pot holds it, members really were debited twice and it is theirs to be refunded or left.
with dupes as (
  select c.group_id, c.member_id, c.cycle_number,
         sum(c.amount_kobo) - min(c.amount_kobo) as excess_kobo,
         count(*) - 1                            as extra_rows
  from public.esusu_contributions c
  where c.cycle_number > 0
  group by c.group_id, c.member_id, c.cycle_number
  having count(*) > 1
)
select
  g.name                            as circle,
  g.status,
  g.current_cycle,
  sum(d.extra_rows)                 as extra_rows,
  sum(d.excess_kobo) / 100.0        as excess_ngn,
  g.pot_balance_kobo / 100.0        as pot_now_ngn,
  g.emergency_pot_kobo / 100.0      as emergency_pot_now_ngn
from dupes d
join public.esusu_groups g on g.id = d.group_id
group by g.id, g.name, g.status, g.current_cycle, g.pot_balance_kobo, g.emergency_pot_kobo
order by sum(d.excess_kobo) desc;

\echo ''
\echo '── 4. would the constraint apply cleanly today? ───────────────────────────'
select
  case when count(*) = 0
    then 'CLEAN — the partial unique index on (group_id, member_id, cycle_number) where cycle_number > 0 will apply'
    else count(*)::text || ' duplicate groups must be resolved first'
  end as verdict
from (
  select 1
  from public.esusu_contributions
  where cycle_number > 0
  group by group_id, member_id, cycle_number
  having count(*) > 1
) x;
