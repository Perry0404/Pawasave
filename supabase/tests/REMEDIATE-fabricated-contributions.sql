-- REMEDIATE-fabricated-contributions.sql
--
-- Clears the client-inserted contribution rows that are blocking migration 105.
--
-- DO NOT RUN ANY OF THIS UNTIL:
--   1. migration 112 is applied, or the hole is still open while you tidy up after it, and
--   2. sections 9 and 10 of DIAGNOSE-duplicate-contributions.sql have been read, because they say
--      whether real cNGN was paid out of these circles. Deleting the rows does not unpay a payout.
--
-- WHAT THE DIAGNOSTIC FOUND, 2026-09-30, circle "Favour demo " (114c9bac):
--   * 6 contribution rows, ALL recording the gross ₦1,000 rather than the ₦995 net that
--     esusu_contribute stores. None came from the RPC.
--   * 0 wallet debits for the payer in the 20-second window.
--   * 0 platform_fees rows, so the 0.5% penalty was never booked.
--   * 5 of the 6 are the same member in cycle 1, written across 16 seconds.
--   * 1 member has already collected, so a payout has run.
--
-- Nobody paid anything into this circle. The rows are fiction, and so is any pot derived from them.
--
-- Everything below is WRAPPED IN A TRANSACTION THAT ROLLS BACK. Read the output, decide, then change
-- the last line to COMMIT.

BEGIN;

-- ── What is about to change ─────────────────────────────────────────────────────────────────
create temp table before_after(step text, detail text);

-- coalesce because sum() over no rows is NULL, and a NULL in a concatenation renders the whole line
-- blank — which reads as "the query is broken" rather than "there is nothing to fix".
insert into before_after
select 'BEFORE: fabricated rows',
       count(*)::text || ' rows, ' || (coalesce(sum(c.amount_kobo), 0)/100.0)::text || ' NGN notional'
from public.esusu_contributions c
join public.esusu_groups g on g.id = c.group_id
where c.amount_kobo = g.contribution_amount_kobo;   -- gross, so not from the RPC

insert into before_after
select 'BEFORE: genuine rows',
       count(*)::text || ' rows'
from public.esusu_contributions c
join public.esusu_groups g on g.id = c.group_id
where c.amount_kobo = g.contribution_amount_kobo - floor(g.contribution_amount_kobo * 0.005);


-- ── OPTION A: delete the fabricated rows, leave the circles standing ────────────────────────
--
-- Use this if the circles are real and you want their history honest. It deletes only rows that
-- record the gross amount, which is the signature of a client insert, and never touches a row the RPC
-- wrote.
--
-- It does NOT correct pot_balance_kobo. If the diagnostic showed a pot larger than the genuine
-- contributions, that surplus is invented money and needs its own decision — see Option C.

delete from public.esusu_contributions c
using public.esusu_groups g
where g.id = c.group_id
  and c.amount_kobo = g.contribution_amount_kobo;

insert into before_after
select 'AFTER: rows remaining', count(*)::text from public.esusu_contributions;


-- ── OPTION B: delete the demo circle outright ──────────────────────────────────────────────
--
-- Use this instead of A if "Favour demo " is a test circle somebody made in production, which the
-- trailing space in the name and the ₦1,000 round numbers both suggest. Cleaner than leaving a
-- half-real circle in the data.
--
-- Uncomment to use. Check the id first; do not delete a circle by name pattern on a hunch.
--
-- delete from public.esusu_contributions where group_id = '114c9bac-d976-485a-81ff-d66ff2791cd8';
-- delete from public.emergency_votes where request_id in (
--   select id from public.emergency_requests where group_id = '114c9bac-d976-485a-81ff-d66ff2791cd8');
-- delete from public.emergency_requests where group_id = '114c9bac-d976-485a-81ff-d66ff2791cd8';
-- delete from public.esusu_members where group_id = '114c9bac-d976-485a-81ff-d66ff2791cd8';
-- delete from public.esusu_groups where id = '114c9bac-d976-485a-81ff-d66ff2791cd8';


-- ── OPTION C: bring the pot back to what was genuinely contributed ─────────────────────────
--
-- Only if section 10 showed a pot bigger than the funded contributions. This is a money correction
-- and it is NOT reversible by rerunning the script, so it wants a second pair of eyes.
--
-- A pot that was never funded cannot be paid out to anybody, so zeroing it takes nothing from a
-- member who is owed. But if a payout has ALREADY gone out of it, that cNGN is in a wallet and this
-- does not claw it back. Section 9 lists those payouts; recovering them is a separate conversation.
--
-- delete from public.esusu_contributions where group_id = '114c9bac-d976-485a-81ff-d66ff2791cd8';
-- update public.esusu_groups
--    set pot_balance_kobo = 0, emergency_pot_kobo = 0
--  where id = '114c9bac-d976-485a-81ff-d66ff2791cd8';


-- ── Does 105 apply now? ────────────────────────────────────────────────────────────────────
insert into before_after
select 'migration 105 verdict',
       case when count(*) = 0 then 'CLEAN — the unique index will apply'
            else count(*)::text || ' duplicate groups still remain' end
from (
  select 1 from public.esusu_contributions
  where cycle_number > 0
  group by group_id, member_id, cycle_number
  having count(*) > 1
) x;

select * from before_after;

-- Change to COMMIT once the output above is what you want.
ROLLBACK;
