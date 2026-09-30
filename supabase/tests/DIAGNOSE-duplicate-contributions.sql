-- DIAGNOSE-duplicate-contributions.sql
--
-- READ ONLY. Run before deciding what to do about the missing unique constraint on
-- esusu_contributions (migration 105).
--
-- RUN THE QUERIES ONE AT A TIME. The Supabase SQL editor shows only the last result set, and psql
-- meta-commands are deliberately not used here so this file works in either.
--
-- The problem. There is no unique (group_id, member_id, cycle_number), and esusu_contribute
-- de-duplicates only the `transactions` ledger row — it debits the wallet and inserts the
-- contribution either way. Migration 071's header records a live case: "one member recorded cycle-1
-- five times". Until migration 100 a client could also insert rows directly with no money moving at
-- all, so there are two kinds of duplicate with opposite meanings:
--
--   PAID TWICE   the member really was debited more than once. The pot holds that money.
--   PHANTOM      a hand-written row with no debit behind it. The pot does not.
--
-- They are told apart by whether a matching `transactions` row exists. esusu_contribute writes the
-- reference `esusu_<group>_<member>_c<cycle>` and the autodebit cron writes
-- `esusu_autodebit_<group>_<member>_c<cycle>`.
--
-- CAUTION on reading section 2. Because esusu_contribute writes the ledger row only when one does not
-- already exist, a genuine double debit leaves TWO contributions and ONE transaction. So "one
-- transaction, two rows" does not prove the second row was free — it is the expected shape of a double
-- tap. Use section 3, which compares the excess against the pot, to tell whether the money arrived.


-- ── 1. THE DECISION TABLE. One row per duplicated (circle, member, cycle). ───────────────────
-- If this returns nothing, 105 applies as-is.
select
  g.name                                   as circle,
  g.status                                 as circle_status,
  g.current_cycle,
  coalesce(nullif(p.display_name, ''), p.tag, m.user_id::text) as member,
  c.cycle_number,
  count(*)                                 as contribution_rows,
  sum(c.amount_kobo) / 100.0               as recorded_total_ngn,
  (sum(c.amount_kobo) - min(c.amount_kobo)) / 100.0 as excess_ngn,
  g.contribution_amount_kobo / 100.0       as expected_per_cycle_ngn,
  g.pot_balance_kobo / 100.0               as pot_now_ngn,
  min(c.paid_at)                           as first_paid,
  max(c.paid_at)                           as last_paid,
  -- Seconds between the first and last row. A handful of seconds is a double tap; days apart is
  -- something else and worth looking at individually.
  round(extract(epoch from (max(c.paid_at) - min(c.paid_at))))  as seconds_apart,
  c.group_id,
  c.member_id
from public.esusu_contributions c
join public.esusu_groups g  on g.id = c.group_id
join public.esusu_members m on m.id = c.member_id
left join public.profiles p on p.id = m.user_id
where c.cycle_number > 0
group by g.id, g.name, g.status, g.current_cycle, g.contribution_amount_kobo, g.pot_balance_kobo,
         p.display_name, p.tag, m.user_id, c.cycle_number, c.group_id, c.member_id
having count(*) > 1
order by count(*) desc, sum(c.amount_kobo) desc;


-- ── 2. ROW-LEVEL DETAIL, with the ids you would act on. ──────────────────────────────────────
-- Read the CAUTION above before concluding a row had no money behind it.
with dupes as (
  select group_id, member_id, cycle_number
  from public.esusu_contributions
  where cycle_number > 0
  group by group_id, member_id, cycle_number
  having count(*) > 1
)
select
  c.id                                     as contribution_id,
  g.name                                   as circle,
  coalesce(nullif(p.display_name, ''), p.tag) as member,
  c.cycle_number,
  c.amount_kobo / 100.0                    as amount_ngn,
  c.paid_at,
  row_number() over (
    partition by c.group_id, c.member_id, c.cycle_number order by c.paid_at
  )                                        as nth_row,
  t.reference                              as ledger_reference,
  t.amount_kobo / 100.0                    as ledger_amount_ngn
from public.esusu_contributions c
join dupes d  on d.group_id = c.group_id and d.member_id = c.member_id
             and d.cycle_number = c.cycle_number
join public.esusu_groups g  on g.id = c.group_id
join public.esusu_members m on m.id = c.member_id
left join public.profiles p on p.id = m.user_id
left join public.transactions t
  on t.user_id = m.user_id
 and t.reference in (
      'esusu_'           || c.group_id::text || '_' || c.member_id::text || '_c' || c.cycle_number::text,
      'esusu_autodebit_' || c.group_id::text || '_' || c.member_id::text || '_c' || c.cycle_number::text
    )
order by c.group_id, c.member_id, c.cycle_number, c.paid_at;


-- ── 3. DID THE MONEY ARRIVE? Pot against what the contributions claim. ───────────────────────
-- The one that decides whether the duplicates are money or noise.
--
-- `contributed_total_ngn` is every contribution recorded for the circle. If the pot roughly matches
-- it (less any payouts already made and any emergency disbursement), the duplicated rows were
-- genuinely funded and the excess is real money sitting in the pot. If the pot matches the total
-- MINUS the excess, the duplicate rows are phantoms and nothing was ever debited for them.
select
  g.name                              as circle,
  g.status,
  g.current_cycle,
  g.pot_balance_kobo / 100.0          as pot_now_ngn,
  g.emergency_pot_kobo / 100.0        as emergency_pot_ngn,
  sum(c.amount_kobo) / 100.0          as contributed_total_ngn,
  coalesce(dupe.excess_kobo, 0) / 100.0 as excess_from_duplicates_ngn,
  (sum(c.amount_kobo) - coalesce(dupe.excess_kobo, 0)) / 100.0 as contributed_excl_excess_ngn,
  (select count(*) from public.esusu_members mm
    where mm.group_id = g.id and mm.has_collected) as members_already_paid_out
from public.esusu_groups g
join public.esusu_contributions c on c.group_id = g.id
left join (
  select group_id, sum(excess) as excess_kobo
  from (
    select group_id, sum(amount_kobo) - min(amount_kobo) as excess
    from public.esusu_contributions
    where cycle_number > 0
    group by group_id, member_id, cycle_number
    having count(*) > 1
  ) x
  group by group_id
) dupe on dupe.group_id = g.id
where g.id in (
  select group_id from public.esusu_contributions
  where cycle_number > 0
  group by group_id, member_id, cycle_number
  having count(*) > 1
)
group by g.id, g.name, g.status, g.current_cycle, g.pot_balance_kobo, g.emergency_pot_kobo,
         dupe.excess_kobo
order by g.name;


-- ── 4. THE ONE THE MIGRATION TRIPPED ON. ────────────────────────────────────────────────────
-- Named explicitly so it can be looked at on its own.
select
  c.id as contribution_id,
  c.amount_kobo / 100.0 as amount_ngn,
  c.paid_at,
  t.reference as ledger_reference
from public.esusu_contributions c
join public.esusu_members m on m.id = c.member_id
left join public.transactions t
  on t.user_id = m.user_id
 and t.reference in (
      'esusu_'           || c.group_id::text || '_' || c.member_id::text || '_c' || c.cycle_number::text,
      'esusu_autodebit_' || c.group_id::text || '_' || c.member_id::text || '_c' || c.cycle_number::text
    )
where c.group_id   = '114c9bac-d976-485a-81ff-d66ff2791cd8'
  and c.member_id  = '163da100-e6fb-4aae-92d6-f7173106f09d'
  and c.cycle_number = 1
order by c.paid_at;


-- ── 5. HOW BIG IS THIS? One number, for deciding how much care it needs. ────────────────────
select
  count(*)                                   as duplicate_groups,
  sum(rows_in_group) - count(*)               as extra_rows_total,
  sum(excess_kobo) / 100.0                   as total_excess_ngn
from (
  select count(*) as rows_in_group,
         sum(amount_kobo) - min(amount_kobo) as excess_kobo
  from public.esusu_contributions
  where cycle_number > 0
  group by group_id, member_id, cycle_number
  having count(*) > 1
) x;


-- ── 6. NET-VS-GROSS: the strongest tell that a row did not come from the RPC. ───────────────
--
-- esusu_contribute takes a 0.5% penalty and records the NET:
--   v_penalty := floor(amount * 0.005); v_net := amount - v_penalty;
--   INSERT INTO esusu_contributions (..., amount_kobo) VALUES (..., v_net_kobo);
--
-- So a ₦1,000 contribution through the RPC records ₦995, not ₦1,000. Every version since migration
-- 009 has done this; only 005 and 007 recorded the gross, and neither wrote a `reference` at all.
--
-- A row holding a round multiple of the circle's contribution amount, with no penalty deducted, was
-- therefore almost certainly written straight into the table by a browser — which RLS allowed until
-- migration 100 closed it.
select
  g.name                                    as circle,
  coalesce(nullif(p.display_name,''), p.tag) as member,
  c.cycle_number,
  c.amount_kobo                             as recorded_kobo,
  g.contribution_amount_kobo                as expected_gross_kobo,
  g.contribution_amount_kobo
    - floor(g.contribution_amount_kobo * 0.005) as expected_net_kobo,
  case
    when c.amount_kobo = g.contribution_amount_kobo
                         - floor(g.contribution_amount_kobo * 0.005)
      then 'RPC — penalty deducted, money moved'
    when c.amount_kobo = g.contribution_amount_kobo
      then 'CLIENT INSERT — gross amount, no penalty taken'
    else 'neither — look at this one by hand'
  end                                       as origin,
  c.paid_at,
  c.id                                      as contribution_id
from public.esusu_contributions c
join public.esusu_groups g  on g.id = c.group_id
join public.esusu_members m on m.id = c.member_id
left join public.profiles p on p.id = m.user_id
where c.cycle_number > 0
order by origin, c.paid_at;


-- ── 7. DID THE WALLET ACTUALLY LOSE THE MONEY? ──────────────────────────────────────────────
--
-- The decisive one, and it assumes nothing about reference formats. Every debit on the payer's
-- wallet in a window around the duplicates. Five ₦1,000 debits means five real payments; one or none
-- means the contribution rows were written without money moving.
--
-- Replace the two ids if you are checking a different pair.
select
  t.created_at,
  t.type,
  t.direction,
  t.amount_kobo / 100.0 as amount_ngn,
  t.status,
  t.reference,
  t.description
from public.transactions t
where t.user_id = (
        select user_id from public.esusu_members
        where id = '163da100-e6fb-4aae-92d6-f7173106f09d'
      )
  and t.created_at between timestamptz '2026-09-07 15:20:00+00'
                       and timestamptz '2026-09-07 15:25:00+00'
order by t.created_at;


-- ── 8. AND DID THE PENALTY EVER GET BOOKED? ─────────────────────────────────────────────────
-- esusu_contribute writes a platform_fees row of type 'esusu_penalty' on every funded contribution.
-- No fee rows for this reference is more evidence the RPC never ran.
select
  f.created_at,
  f.fee_type,
  f.gross_amount_kobo / 100.0 as gross_ngn,
  f.fee_amount_kobo / 100.0   as fee_ngn,
  f.transaction_ref
from public.platform_fees f
where f.transaction_ref like 'esusu_114c9bac-d976-485a-81ff-d66ff2791cd8%'
order by f.created_at;
