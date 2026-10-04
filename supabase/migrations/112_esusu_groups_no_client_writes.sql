-- 112_esusu_groups_no_client_writes.sql
--
-- Stop a circle owner writing their own pot balance. This is a live mint.
--
-- THE HOLE. `001_initial.sql:78` grants the owner everything:
--
--   create policy "Owner manages group" on public.esusu_groups for all using (owner_id = auth.uid());
--
-- FOR ALL includes UPDATE, and `authenticated` holds UPDATE on the table, so the owner of a circle can
-- set `pot_balance_kobo` to any number from a browser. `process_esusu_payout` then pays that number
-- out as real spendable cNGN:
--
--   UPDATE public.wallets SET usdc_balance_micro = usdc_balance_micro + (v_net_payout_kobo * 10000)
--
-- Reproduced against head, one member, one circle:
--   contribute ₦1,000 genuinely  ->  UPDATE pot_balance_kobo = 5000000  ->  process_esusu_payout
--   ->  wallet up ₦49,000 that nobody funded. The number is whatever the attacker types.
--
-- Migration 100 closed the other half of this by stopping client INSERTs into esusu_contributions,
-- which is what stops the *contribution count* being faked. It was not enough on its own: the payout
-- only checks that every member has a contribution row, not that the pot matches them, so one real
-- ₦1,000 contribution plus an invented pot is all it takes.
--
-- 100's header named this policy as "STILL OPEN, deliberately not in this migration" because the web
-- app's circle create depends on it. It does not depend on UPDATE — see below.
--
-- WHAT ACTUALLY NEEDS CLIENT WRITES. Checked against frontend/src rather than assumed:
--   groups-view.tsx:117  INSERT into esusu_groups  (create a rotating circle)
--   groups-view.tsx:123  INSERT into esusu_members
--   everything else on both tables is SELECT.
-- No client anywhere UPDATEs or DELETEs esusu_groups, so removing that costs nothing.
-- /api/circles/create uses the service role and is unaffected by any of this.
--
-- THE FIX, in two parts:
--   1. Replace the FOR ALL policy with an INSERT-only one. SELECT is already covered by
--      "Members read groups" and "Authenticated read any group", and with no UPDATE or DELETE policy
--      RLS denies both outright.
--   2. Column-level INSERT grant, so a client cannot create a circle with a pot already in it.
--      Without this, part 1 alone still allows `INSERT ... (pot_balance_kobo) VALUES (5000000)`.
--
-- Columns deliberately left out of the grant: pot_balance_kobo, emergency_pot_kobo, status,
-- cycle_started_at, settled_at, beneficiary_id, xend_mm_usdc_micro, xend_mm_cycle_start_at. Every one
-- either holds money or records what the engine decided, and all of them have safe defaults.
--
-- MANUAL STEP: none. No data changes.
--
-- SEPARATE, NOT FIXED HERE: esusu_members still has "Users insert self" FOR INSERT, which is how the
-- web app adds the creator as member 1. UPDATE and DELETE on that table are already denied because it
-- has no policy for either, despite the grants, so there is no equivalent hole. Moving circle create
-- behind /api/circles/create would let both INSERT policies go; that is a product change, not a
-- security one, and it is tracked in the spec.

-- ── 1. the owner may create a circle, and nothing more ───────────────────────
DROP POLICY IF EXISTS "Owner manages group" ON public.esusu_groups;

CREATE POLICY "Owner creates group" ON public.esusu_groups
  FOR INSERT WITH CHECK (owner_id = auth.uid());

-- ── 2. no client UPDATE or DELETE, at the grant level as well as the policy ──
-- Belt and braces, the same way 080 and 100 did it: with no policy the grant is already inert, but a
-- future migration adding a permissive policy should not silently reopen this.
REVOKE UPDATE, DELETE ON public.esusu_groups FROM authenticated;
REVOKE UPDATE, DELETE ON public.esusu_groups FROM anon, PUBLIC;

-- ── 3. and a create cannot carry a pot ───────────────────────────────────────
REVOKE INSERT ON public.esusu_groups FROM authenticated, anon, PUBLIC;
GRANT INSERT (
  name,
  owner_id,
  contribution_amount_kobo,
  cycle_period,
  max_members,
  current_cycle,
  creator_incentive_percent,
  circle_type,
  payout_mode,
  purpose,
  goal_kobo,
  deadline
) ON public.esusu_groups TO authenticated;

COMMENT ON COLUMN public.esusu_groups.pot_balance_kobo IS
  'Money held for the current cycle. Written ONLY by esusu_contribute, circle_contribute, '
  'esusu_autodebit and process_esusu_payout, all SECURITY DEFINER. Clients have no INSERT or UPDATE '
  'privilege on this column: writing it directly and calling process_esusu_payout was a mint. See 112.';
