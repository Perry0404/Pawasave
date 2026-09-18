-- APPLY-073-074.sql
--
-- Run this in the Supabase SQL editor BEFORE deploying commit 64841a4.
--
-- Ordering matters and the failure is not graceful. custody-lease.ts fails CLOSED: until
-- try_acquire_lease exists, every custody path refuses to run. That means off-ramp
-- withdrawals, equity buys and sells, and all four supply crons stop. The sell reconciler
-- also selects equity_sales.settle_attempts, which does not exist yet, so that cron
-- returns 500 until 074 lands.
--
-- Both halves are idempotent, so re-running is safe. Section 3 at the bottom verifies.

-- ─────────────────────────────────────────────────────────────
-- 073: fencing-token lease for the shared custody wallet
-- ─────────────────────────────────────────────────────────────

-- system_locks was created by migration 054, which is not in the repo, so its exact shape
-- in production is unverified. try_acquire_lease uses ON CONFLICT (key), which needs a
-- unique constraint on key or it throws at call time and every custody path fails closed.
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

  -- No row returned means the key was held and unexpired.
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

-- ─────────────────────────────────────────────────────────────
-- 074: bound the sell reconciler
-- ─────────────────────────────────────────────────────────────

alter table public.equity_sales
  add column if not exists settle_attempts   int not null default 0,
  add column if not exists last_settle_error text,
  add column if not exists last_settle_at    timestamptz;

-- Record a retry that did not fill. Kept separate from settle_equity_sell so a failed
-- attempt never touches status, shares or balances.
create or replace function public.bump_equity_sell_attempt(
  p_sale_id bigint,
  p_error   text default null
) returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_attempts int;
begin
  update public.equity_sales
  set settle_attempts   = settle_attempts + 1,
      last_settle_error = left(coalesce(p_error, ''), 500),
      last_settle_at    = now()
  where id = p_sale_id
  returning settle_attempts into v_attempts;

  return coalesce(v_attempts, -1);
end;
$$;

revoke all on function public.bump_equity_sell_attempt(bigint, text) from public, anon, authenticated;
grant execute on function public.bump_equity_sell_attempt(bigint, text) to service_role;

-- Sales the reconciler has given up on, for the ops dashboard.
create or replace view public.equity_sales_needing_attention as
  select id, user_id, symbol, shares, usdc_micro, broker_ref,
         settle_attempts, last_settle_error, last_settle_at, created_at
  from public.equity_sales
  where status = 'settling'
    and settle_attempts >= 12;

revoke all on public.equity_sales_needing_attention from public, anon, authenticated;
grant select on public.equity_sales_needing_attention to service_role;

-- ─────────────────────────────────────────────────────────────
-- Verification. Every row should read PASS.
-- ─────────────────────────────────────────────────────────────

with checks as (
  select 1 as ord, 'lease functions exist' as check_name,
         count(*)::text || ' of 4' as detail,
         count(*) = 4 as ok
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('try_acquire_lease', 'refresh_lease', 'release_lease', 'lease_status')

  union all
  select 2, 'lease functions pin search_path',
         count(*)::text || ' of 4', count(*) = 4
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('try_acquire_lease', 'refresh_lease', 'release_lease', 'lease_status')
    and array_to_string(p.proconfig, ',') like '%search_path%'

  union all
  select 3, 'lease functions not client callable',
         coalesce(string_agg(distinct p.proname, ', '), 'none reachable'),
         count(*) = 0
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('try_acquire_lease', 'refresh_lease', 'release_lease', 'lease_status')
    and (has_function_privilege('anon', p.oid, 'execute')
      or has_function_privilege('authenticated', p.oid, 'execute'))

  union all
  select 4, 'system_locks has token columns',
         count(*)::text || ' of 3', count(*) = 3
  from information_schema.columns
  where table_schema = 'public' and table_name = 'system_locks'
    and column_name in ('token', 'holder', 'acquired_at')

  union all
  select 5, 'equity_sales has attempt columns',
         count(*)::text || ' of 3', count(*) = 3
  from information_schema.columns
  where table_schema = 'public' and table_name = 'equity_sales'
    and column_name in ('settle_attempts', 'last_settle_error', 'last_settle_at')

  union all
  select 6, 'bump_equity_sell_attempt exists',
         count(*)::text, count(*) = 1
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'bump_equity_sell_attempt'

  union all
  select 7, 'needs-attention view exists',
         count(*)::text, count(*) = 1
  from information_schema.views
  where table_schema = 'public' and table_name = 'equity_sales_needing_attention'

  -- Exercises the real thing, which is the only way to catch a missing unique constraint
  -- on system_locks.key. LATERAL forces the acquire to happen before the release rather
  -- than leaving the order to the planner.
  union all
  select 8, 'lease round trip',
         case when acq.t is null then 'could not acquire'
              when rel.released then 'acquired and released'
              else 'acquired but release failed' end,
         acq.t is not null and rel.released
  from (select public.try_acquire_lease('selftest:apply', 5, 'apply-script') as t) acq
  cross join lateral (select public.release_lease('selftest:apply', acq.t) as released) rel
)
select case when ok then 'PASS' else 'FAIL' end as result, check_name, detail
from checks
order by ord;
