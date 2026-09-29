-- 104_emergency_no_client_insert.sql  (run after 103)
--
-- Stop clients writing the emergency-vote tables.
--
-- A circle's emergency pot is 5% of every rotating contribution, set aside so a member in trouble
-- can be voted a payout. Two policies from 001 let a client write the tables that govern it:
--
--   "Members insert requests" on emergency_requests, with check (auth.uid() = requester_id)
--   "Members insert votes"    on emergency_votes,    with check (auth.uid() = voter_id)
--
-- An INSERT policy cannot restrict which columns are set, so both are wider than they look.
--
-- A hand-written request skips every guard in request_emergency_payout: the amount ceiling against
-- emergency_pot_kobo, and "only one active vote per group at a time". So a member could open any
-- number of concurrent votes, for any amount, and the circle would be looking at a queue of requests
-- nobody sanctioned.
--
-- A hand-written vote is worse in a quieter way. cast_emergency_vote is what counts the majority and
-- disburses, so a row inserted directly is a vote that exists and does nothing: the threshold is
-- never re-evaluated and the payout never fires. The `unique(request_id, voter_id)` constraint then
-- means the member cannot vote properly afterwards either, because their real vote collides with the
-- fake one. A member could silently deny somebody else's emergency payout by voting by hand.
--
-- Nothing legitimate writes either table from a client. Checked against frontend/src: groups-view
-- reads both and calls request_emergency_payout and cast_emergency_vote for the writes, and both are
-- SECURITY DEFINER so they bypass RLS and are unaffected.
--
-- Reads are untouched. Members still see their circle's requests and votes, which is what makes a
-- vote count visible while it is running.

drop policy if exists "Members insert requests" on public.emergency_requests;
drop policy if exists "Members insert votes"    on public.emergency_votes;

-- Belt and braces, the way 080 and 100 did it: with the policies gone the grants are inert, but
-- leaving INSERT granted means the next policy added by accident is immediately live.
revoke insert, update, delete on public.emergency_requests from anon, authenticated;
revoke insert, update, delete on public.emergency_votes    from anon, authenticated;

comment on table public.emergency_requests is
  'A member asking the circle to release part of its emergency pot. Written only by '
  'request_emergency_payout, which enforces the amount ceiling and one active vote per circle. '
  'Clients read, never write. See 104.';

comment on table public.emergency_votes is
  'Votes on an emergency request. Written only by cast_emergency_vote, which is also what counts the '
  'majority and disburses — so a client-written row is a vote that never triggers a payout and, '
  'because of the unique constraint, blocks the voter from casting a real one. See 104.';
