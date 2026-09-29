-- 105_esusu_contributions_unique_cycle.sql  (run after 104)
--
-- One contribution per member per rotating cycle, enforced by the database.
--
-- RUN supabase/tests/DIAGNOSE-duplicate-contributions.sql FIRST. This migration will FAIL, safely and
-- with no changes, if any duplicates exist — which is the point. Deciding what to do about them is a
-- money question and it is not one a migration should make on anybody's behalf.
--
-- WHY THIS WAS MISSING. `esusu_contribute` de-duplicates only the `transactions` ledger row: it
-- checks `IF NOT EXISTS (... WHERE reference = v_ref)` before writing the ledger, but the wallet
-- debit and the `esusu_contributions` insert happen unconditionally. So a double tap debited twice
-- and recorded twice. Migration 071's header records the live case — "one member recorded cycle-1
-- five times" — and flagged the guard as the next thing to add. It is fifteen migrations later
-- because the existing rows had to be dealt with first.
--
-- WHY IT MATTERS BEYOND THE DOUBLE DEBIT. `process_esusu_payout` decides a cycle is fully funded by
-- counting DISTINCT member_id, so duplicates do not let a cycle settle early. But until migration 100
-- a client could insert rows directly with no money behind them at all, and those did: a member could
-- record themselves as paid, be skipped by the autodebit cron, and still collect their payout. 100
-- closed the door; this closes the shape of the hole.
--
-- PARTIAL, on `cycle_number > 0`. A collection circle uses cycle 0 and contributes many times to one
-- pot — that is what a collection is — so a blanket constraint would break aso ebi, event dues,
-- harambee and group buys.
--
-- The app already guards this at /api/circles/ajo/contribute, which refuses a second contribution in
-- the same cycle. That guard stays: it gives the user a sentence instead of a constraint violation,
-- and it is the only thing protecting the wallet debit, which happens before the insert.

CREATE UNIQUE INDEX IF NOT EXISTS esusu_contributions_one_per_cycle
  ON public.esusu_contributions (group_id, member_id, cycle_number)
  WHERE cycle_number > 0;

COMMENT ON INDEX public.esusu_contributions_one_per_cycle IS
  'One contribution per member per rotating cycle. Partial on cycle_number > 0 because a collection '
  'circle uses cycle 0 and contributes repeatedly to one pot. See 105.';
