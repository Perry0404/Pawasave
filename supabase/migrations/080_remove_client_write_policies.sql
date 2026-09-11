-- 080_remove_client_write_policies.sql  (run after 079)
--
-- Revoking execute on the functions was necessary and was not sufficient. RLS policies granted
-- the same power directly on the tables, so a signed-in user could do with an UPDATE what
-- credit_wallet used to do with a call.
--
-- Proved on staging by simulating a real browser session, role `authenticated` plus a
-- request.jwt.claims sub, which is exactly what auth.uid() reads. Five of seven attacks
-- succeeded with nothing but a login and the public anon key:
--
--   set own wallet balance to 999,999,999      SUCCEEDED
--   self-elevate kyc_status to 'verified'      SUCCEEDED, lifting the withdrawal cap
--   author a fake deposit ledger row           SUCCEEDED
--   backdate own lock unlocks_at and mature it SUCCEEDED, dodging the early-exit penalty
--   inflate own goal saved_usdc_micro          SUCCEEDED
--
-- The two that failed are instructive. The transaction PIN was blocked, but only because
-- migration 045 gave it a trigger, and writing another user's row was blocked because the
-- policies scope by auth.uid(). The policies do exactly what they say. The design is the
-- problem: an UPDATE policy with a USING clause and no column restriction lets a client
-- rewrite every column of a row it owns, including balances.
--
-- Safe to drop these with no code change: the browser only ever SELECTs from wallets,
-- profiles and savings_locks. Verified by grepping every client component and hook for
-- .update, .insert, .upsert and .delete against those tables. Nothing writes them.
--
-- NOT addressed here. `transactions` still carries "Users insert own txs", because
-- hooks/use-data.ts writes its own ledger rows from the browser in six places. Removing that
-- policy needs those moved server-side first, so it is left in place deliberately rather than
-- breaking the app. It means the ledger is still client-authored and cannot be treated as
-- trustworthy for reconciliation until that is done.
--
-- Run in the Supabase SQL editor. Safe to run more than once.

-- ── wallets: no client write at all ─────────────────────────────────────────
-- This is the one that allowed arbitrary self-credit.
drop policy if exists "Users update own wallet" on public.wallets;

-- Both INSERT policies exist to let signup create the row. handle_new_user is SECURITY
-- DEFINER and owned by a role that owns the table, so it bypasses RLS and does not need
-- either. "Allow trigger to insert wallet" had WITH CHECK (true), which let any caller insert
-- a wallet row for any user id.
drop policy if exists "Allow trigger to insert wallet" on public.wallets;
drop policy if exists "Allow inserts during auth flow" on public.wallets;

-- ── profiles: display name and preferences only, never KYC ──────────────────
-- Dropping the UPDATE policy outright rather than extending migration 045's trigger. A
-- trigger has to enumerate the columns to protect and silently misses any added later;
-- removing the write closes the whole surface. Nothing in the browser updates profiles.
drop policy if exists "Users update own profile" on public.profiles;
drop policy if exists "Allow inserts during auth flow" on public.profiles;
drop policy if exists "Allow trigger to insert profile" on public.profiles;

-- ── savings_locks: created and settled by functions, never by the client ────
drop policy if exists "Users update own locks" on public.savings_locks;
drop policy if exists "Users insert own locks" on public.savings_locks;

-- ── savings_goals: the client may create one, nothing more ──────────────────
-- The ALL policy covered UPDATE and DELETE too, which is how saved_usdc_micro could be
-- inflated before claiming the goal.
drop policy if exists "Users manage own goals" on public.savings_goals;

create policy "Users read own goals" on public.savings_goals
  for select to authenticated
  using (auth.uid() = user_id);

create policy "Users create own goals" on public.savings_goals
  for insert to authenticated
  with check (auth.uid() = user_id);

-- An INSERT policy cannot restrict which columns are set, so a client could still create a
-- goal that already claims progress. Force the progress and status columns to their starting
-- values whenever the inserting role is a client.
create or replace function public.goals_force_client_insert_defaults()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(auth.role(), '') in ('authenticated', 'anon') then
    new.saved_naira_kobo             := 0;
    new.saved_usdc_micro             := 0;
    new.interest_earned_micro        := 0;
    new.interest_forfeited_usdc_micro := 0;
    new.status                       := 'active';
    new.completed_at                 := null;
    new.started_at                   := coalesce(new.started_at, now());
  end if;
  return new;
end;
$$;

drop trigger if exists trg_goals_client_insert_defaults on public.savings_goals;
create trigger trg_goals_client_insert_defaults
  before insert on public.savings_goals
  for each row execute function public.goals_force_client_insert_defaults();

revoke all on function public.goals_force_client_insert_defaults() from public, anon, authenticated;

-- ── revoke the table grants the policies were gating ────────────────────────
-- Belt and braces. With the policies gone the grants are inert, but leaving INSERT, UPDATE and
-- DELETE granted means the next policy added by accident is immediately live.
revoke insert, update, delete on public.wallets       from anon, authenticated;
revoke insert, update, delete on public.profiles      from anon, authenticated;
revoke insert, update, delete on public.savings_locks from anon, authenticated;
revoke update, delete         on public.savings_goals from anon, authenticated;
revoke insert, update, delete on public.revenue_journal from anon, authenticated;

-- savings_goals keeps INSERT for the create-a-goal flow.
grant insert on public.savings_goals to authenticated;
