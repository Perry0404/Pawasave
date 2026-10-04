-- 100_esusu_contributions_no_client_insert.sql  (run after 099)
--
-- A member can currently skip paying into an ajo and still collect their payout.
--
-- The policy "Members insert contributions" (004) lets a signed-in user INSERT a row into
-- esusu_contributions for any member row that is theirs, with any amount_kobo and any
-- cycle_number, without money moving. Two engines read that table as proof of payment:
--
--   esusu_autodebit skips members who already have a row for the current cycle, so a faked row
--   means never being debited and never taking a strike.
--
--   process_esusu_payout counts DISTINCT member_id for the cycle and settles once the count
--   reaches the active member total, so faked rows also bring the payout forward.
--
-- Net effect: contribute nothing, collect your position, and the shortfall is carried by the
-- members who did pay. 080 closed the equivalent holes on wallets, profiles, savings_locks and
-- savings_goals but left the esusu tables alone; 082's header records that as deliberate on the
-- grounds that "the esusu tables still take browser writes". For this table they do not.
--
-- Nothing legitimate inserts here from a browser. Every real contribution row is written by
-- esusu_contribute, esusu_contribute_crypto, esusu_autodebit or circle_contribute, all
-- SECURITY DEFINER, which bypass RLS and are unaffected. Checked against frontend/src: the only
-- client reference to esusu_contributions is a SELECT in groups-view.tsx.
--
-- STILL OPEN, deliberately not in this migration: esusu_groups "Owner manages group" (FOR ALL)
-- and esusu_members "Users insert self" are how the Next app creates a rotating circle
-- (groups-view.tsx:117 and :123), so revoking them breaks a live path. That create has to move
-- to /api/circles/create first. Tracked in the circles-savings-invest-loans spec.

drop policy if exists "Members insert contributions" on public.esusu_contributions;

-- Belt and braces, the same way 080 did it: with the policy gone the grant is inert, but
-- leaving INSERT granted means the next policy added by accident is immediately live.
revoke insert, update, delete on public.esusu_contributions from anon, authenticated;

comment on table public.esusu_contributions is
  'Proof of payment into a circle. Written only by SECURITY DEFINER RPCs (esusu_contribute, '
  'esusu_contribute_crypto, esusu_autodebit, circle_contribute). Clients read, never write: a '
  'client-written row is a free ride, because esusu_autodebit treats it as paid and '
  'process_esusu_payout counts it toward settling the cycle. See 100.';
