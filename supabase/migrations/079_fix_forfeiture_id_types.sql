-- 079_fix_forfeiture_id_types.sql  (run after 078)
--
-- record_lock_forfeiture and record_goal_forfeiture have never worked.
--
-- Both declare their id parameter as bigint:
--   record_lock_forfeiture(p_lock_id bigint, p_user_id uuid, p_forfeited_interest_usdc_micro bigint)
-- and then compare it to a uuid primary key:
--   UPDATE public.savings_locks ... WHERE id = p_lock_id
--
-- savings_locks.id and savings_goals.id are both uuid, so every call raises
-- 'operator does not exist: uuid = bigint' before touching anything. The browser called them
-- without checking the error, so the failure was silent.
--
-- Evidence it never once succeeded: revenue_journal has zero rows in production, and both
-- goals with status 'broken' have interest_forfeited_usdc_micro = 0. The early-exit penalty in
-- the product terms has therefore never been applied, and the forfeited-interest revenue line
-- is currently fictional. Measured impact is small, roughly 209 naira on one internal account,
-- because only two goals were ever broken and no lock has ever been withdrawn.
--
-- Found by calling every function on staging with null arguments and classifying the errors,
-- while checking whether pinning search_path had broken anything. It had not; this had been
-- broken all along.
--
-- Also returns boolean now instead of void, so a caller can tell a recorded forfeiture from a
-- no-op. Returning void meant a missing row and a successful write looked identical, which is
-- how this stayed hidden.
--
-- Run in the Supabase SQL editor. Safe to run more than once.

-- The bigint signatures cannot be kept alongside the uuid ones: PostgREST resolves by argument
-- name, and two candidates differing only by type would be ambiguous.
drop function if exists public.record_lock_forfeiture(bigint, uuid, bigint);
drop function if exists public.record_goal_forfeiture(bigint, uuid, bigint);

create or replace function public.record_lock_forfeiture(
  p_lock_id                        uuid,
  p_user_id                        uuid,
  p_forfeited_interest_usdc_micro  bigint
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rows int;
begin
  if p_forfeited_interest_usdc_micro is null or p_forfeited_interest_usdc_micro <= 0 then
    return false;
  end if;

  -- Scoped to the owner as well as the id, so a caller cannot record a forfeiture against
  -- someone else's lock even though this runs as the definer.
  update public.savings_locks
  set interest_forfeited_usdc_micro = p_forfeited_interest_usdc_micro
  where id = p_lock_id
    and user_id = p_user_id;
  get diagnostics v_rows = row_count;

  if v_rows = 0 then
    return false;
  end if;

  insert into public.revenue_journal
    (user_id, transaction_id, revenue_type, amount_usdc_micro, description)
  values
    (p_user_id, null, 'lock_interest_forfeited', p_forfeited_interest_usdc_micro,
     'Interest forfeited from early lock withdrawal');

  return true;
end;
$$;

create or replace function public.record_goal_forfeiture(
  p_goal_id                        uuid,
  p_user_id                        uuid,
  p_forfeited_interest_usdc_micro  bigint
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rows int;
begin
  if p_forfeited_interest_usdc_micro is null or p_forfeited_interest_usdc_micro <= 0 then
    return false;
  end if;

  update public.savings_goals
  set interest_forfeited_usdc_micro = p_forfeited_interest_usdc_micro
  where id = p_goal_id
    and user_id = p_user_id;
  get diagnostics v_rows = row_count;

  if v_rows = 0 then
    return false;
  end if;

  insert into public.revenue_journal
    (user_id, transaction_id, revenue_type, amount_usdc_micro, description)
  values
    (p_user_id, null, 'goal_interest_forfeited', p_forfeited_interest_usdc_micro,
     'Interest forfeited from breaking goal before target');

  return true;
end;
$$;

-- Service role only. The route in api/savings/forfeit-withdraw is the sole caller, and it
-- derives the amount from the stored row rather than accepting one from the client.
revoke all on function public.record_lock_forfeiture(uuid, uuid, bigint) from public, anon, authenticated;
revoke all on function public.record_goal_forfeiture(uuid, uuid, bigint) from public, anon, authenticated;
grant execute on function public.record_lock_forfeiture(uuid, uuid, bigint) to service_role;
grant execute on function public.record_goal_forfeiture(uuid, uuid, bigint) to service_role;
