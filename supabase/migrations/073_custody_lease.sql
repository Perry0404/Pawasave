-- 073_custody_lease.sql
-- A fencing-token lease so only one process at a time signs with the custody wallet.
--
-- Why the existing lock is not enough. try_acquire_lock/release_lock (migration 054)
-- release by key alone, so a slow process can release a lease another process now holds
-- and both then proceed. supply-lock.ts also fails OPEN on any RPC error, which was the
-- right call when it only guarded pool supply and wrong now that it has to guard money.
--
-- What changes. A lease returns an opaque token. Release and refresh only succeed for the
-- current token holder. Callers can hold a lease across a whole multi-leg order and
-- refresh it, because HyperFX alone can run 195s against the old fixed 180s TTL, which is
-- one way two holders arise.
--
-- The old functions are left in place so existing call sites keep working during rollout.
--
-- system_locks already has RLS enabled with no policies, so clients are denied. These
-- functions are service_role only.
--
-- Run in the Supabase SQL editor. Safe to run more than once.

-- system_locks came from migration 054, which is not in this repo, so its shape in
-- production is unverified. try_acquire_lease uses ON CONFLICT (key), which needs a unique
-- constraint on key or it throws at call time and every custody path then fails closed.
-- Create the table if it is somehow absent and make sure key is unique either way.
create table if not exists public.system_locks (
  key          text primary key,
  locked_until timestamptz not null default now()
);

alter table public.system_locks enable row level security;

alter table public.system_locks
  add column if not exists token       uuid,
  add column if not exists holder      text,
  add column if not exists acquired_at timestamptz;

do $$
begin
  if not exists (
    select 1
    from pg_index i
    join pg_class c on c.oid = i.indrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum = any (i.indkey)
    where n.nspname = 'public' and c.relname = 'system_locks'
      and i.indisunique and i.indnatts = 1 and a.attname = 'key'
  ) then
    create unique index system_locks_key_uniq on public.system_locks (key);
    raise notice 'added missing unique index on system_locks.key';
  end if;
end
$$;

-- Claim a lease. Returns a token on success, NULL when someone else holds it.
-- An expired lease is stealable, so a crashed holder cannot wedge the key forever.
create or replace function public.try_acquire_lease(
  p_key         text,
  p_ttl_seconds int  default 180,
  p_holder      text default null
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_token uuid := gen_random_uuid();
begin
  insert into public.system_locks (key, locked_until, token, holder, acquired_at)
  values (p_key, now() + make_interval(secs => p_ttl_seconds), v_token, p_holder, now())
  on conflict (key) do update
    set locked_until = excluded.locked_until,
        token        = excluded.token,
        holder       = excluded.holder,
        acquired_at  = now()
    where public.system_locks.locked_until < now()
  returning public.system_locks.token into v_token;

  -- No row returned means the conflict target was held and unexpired.
  return v_token;
end;
$$;

-- Extend a lease we still hold. False means we lost it, and the caller must stop rather
-- than assume it still has exclusivity.
create or replace function public.refresh_lease(
  p_key         text,
  p_token       uuid,
  p_ttl_seconds int default 180
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rows int;
begin
  update public.system_locks
  set locked_until = now() + make_interval(secs => p_ttl_seconds)
  where key = p_key
    and token = p_token
    and locked_until > now();
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

-- Release only if we are still the holder. This is the part the old release_lock lacked.
create or replace function public.release_lease(
  p_key   text,
  p_token uuid
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rows int;
begin
  delete from public.system_locks where key = p_key and token = p_token;
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

-- Read-only view of who holds what, for debugging a stuck key.
create or replace function public.lease_status(p_key text)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select jsonb_build_object(
       'key', key, 'holder', holder, 'acquired_at', acquired_at,
       'locked_until', locked_until, 'expired', locked_until < now())
     from public.system_locks where key = p_key),
    jsonb_build_object('key', p_key, 'held', false))
$$;

revoke all on function public.try_acquire_lease(text, int, text) from public, anon, authenticated;
revoke all on function public.refresh_lease(text, uuid, int)     from public, anon, authenticated;
revoke all on function public.release_lease(text, uuid)          from public, anon, authenticated;
revoke all on function public.lease_status(text)                 from public, anon, authenticated;

grant execute on function public.try_acquire_lease(text, int, text) to service_role;
grant execute on function public.refresh_lease(text, uuid, int)     to service_role;
grant execute on function public.release_lease(text, uuid)          to service_role;
grant execute on function public.lease_status(text)                 to service_role;
