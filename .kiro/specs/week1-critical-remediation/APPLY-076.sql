-- APPLY-076.sql
--
-- Run in the Supabase SQL editor. Can go before or after the 076 deploy: the code only
-- calls record_custody_divergence on a failure path, so a missing function would surface as
-- a logged RPC error rather than a stranded order. Applying first is still preferable.
--
-- Idempotent. Verification at the bottom.

create table if not exists public.custody_divergence (
  id                     bigserial primary key,
  kind                   text not null,
  ref_table              text,
  ref_id                 bigint,
  user_id                uuid,
  asset                  text not null check (asset in ('cngn', 'usdc', 'eth')),
  amount_micro           bigint not null check (amount_micro > 0),
  place_tx               text,
  detail                 text,
  status                 text not null default 'open'
                         check (status in ('open', 'recovered', 'written_off')),
  recovered_amount_micro bigint,
  recovered_tx           text,
  recovered_at           timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index if not exists idx_custody_divergence_open
  on public.custody_divergence (status, created_at desc);

create unique index if not exists custody_divergence_place_tx_uniq
  on public.custody_divergence (place_tx) where place_tx is not null;

alter table public.custody_divergence enable row level security;
-- No policies on purpose. Clients have no business reading the float position.

create or replace function public.record_custody_divergence(
  p_kind         text,
  p_asset        text,
  p_amount_micro bigint,
  p_ref_table    text default null,
  p_ref_id       bigint default null,
  p_user_id      uuid default null,
  p_place_tx     text default null,
  p_detail       text default null
) returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id bigint;
begin
  if p_amount_micro is null or p_amount_micro <= 0 then
    return null;
  end if;

  insert into public.custody_divergence
    (kind, asset, amount_micro, ref_table, ref_id, user_id, place_tx, detail)
  values
    (p_kind, p_asset, p_amount_micro, p_ref_table, p_ref_id, p_user_id, p_place_tx,
     left(coalesce(p_detail, ''), 1000))
  on conflict (place_tx) where place_tx is not null do update
    set detail = left(coalesce(excluded.detail, public.custody_divergence.detail), 1000),
        updated_at = now()
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.resolve_custody_divergence(
  p_id                     bigint,
  p_status                 text,
  p_recovered_amount_micro bigint default null,
  p_recovered_tx           text default null,
  p_detail                 text default null
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rows int;
begin
  if p_status not in ('recovered', 'written_off') then
    return false;
  end if;

  update public.custody_divergence
  set status                 = p_status,
      recovered_amount_micro = p_recovered_amount_micro,
      recovered_tx           = p_recovered_tx,
      recovered_at           = now(),
      detail                 = left(coalesce(p_detail, detail), 1000),
      updated_at             = now()
  where id = p_id
    and status = 'open';
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

create or replace view public.custody_divergence_open as
  select asset,
         count(*)          as events,
         sum(amount_micro) as short_micro,
         min(created_at)   as oldest,
         max(created_at)   as newest
  from public.custody_divergence
  where status = 'open'
  group by asset;

revoke all on public.custody_divergence      from public, anon, authenticated;
revoke all on public.custody_divergence_open from public, anon, authenticated;
revoke all on function public.record_custody_divergence(text, text, bigint, text, bigint, uuid, text, text) from public, anon, authenticated;
revoke all on function public.resolve_custody_divergence(bigint, text, bigint, text, text) from public, anon, authenticated;

grant select, insert, update on public.custody_divergence to service_role;
grant usage, select on sequence public.custody_divergence_id_seq to service_role;
grant select on public.custody_divergence_open to service_role;
grant execute on function public.record_custody_divergence(text, text, bigint, text, bigint, uuid, text, text) to service_role;
grant execute on function public.resolve_custody_divergence(bigint, text, bigint, text, text) to service_role;

-- No backfill. An earlier draft of this file loaded the six orders stranded on 7 Sep as open
-- shortfalls, which would have been wrong. Re-checking on-chain showed custody cancelled all
-- six at 09:40 UTC on 8 Sep and recovered 6.505402 USDC of the 6.508589 it had escrowed,
-- then two fresh orders filled within 16 seconds on the pinned SDK. That incident opened and
-- closed before this table existed and the only residue is about 0.0032 USDC of fee dust, so
-- there is nothing to carry forward. The table starts empty and fills from real events.

-- ─────────────────────────────────────────────────────────────
-- Verification
-- ─────────────────────────────────────────────────────────────

with checks as (
  select 1 as ord, 'divergence table has the needed columns' as check_name,
         count(*)::text || ' of 8 required' as detail, count(*) = 8 as ok
  from information_schema.columns
  where table_schema = 'public' and table_name = 'custody_divergence'
    and column_name in ('kind', 'asset', 'amount_micro', 'place_tx',
                        'status', 'recovered_amount_micro', 'recovered_tx', 'ref_id')

  union all
  select 2, 'divergence functions exist', count(*)::text || ' of 2', count(*) = 2
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('record_custody_divergence', 'resolve_custody_divergence')

  union all
  select 3, 'divergence functions pin search_path', count(*)::text || ' of 2', count(*) = 2
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('record_custody_divergence', 'resolve_custody_divergence')
    and array_to_string(p.proconfig, ',') like '%search_path%'

  union all
  select 4, 'divergence not client readable',
         case when has_table_privilege('anon', 'public.custody_divergence', 'select')
                or has_table_privilege('authenticated', 'public.custody_divergence', 'select')
              then 'REACHABLE' else 'denied' end,
         not (has_table_privilege('anon', 'public.custody_divergence', 'select')
           or has_table_privilege('authenticated', 'public.custody_divergence', 'select'))

  union all
  select 5, 'dedupe index on place_tx present',
         coalesce(string_agg(indexname, ', '), 'MISSING'), count(*) = 1
  from pg_indexes
  where schemaname = 'public' and indexname = 'custody_divergence_place_tx_uniq'

  union all
  -- Diagnostic, not a gate. Should be empty on a first run.
  select 6, 'shortfalls currently open',
         count(*)::text || ' rows', true
  from public.custody_divergence where status = 'open'
)
select case when ok then 'PASS' else 'FAIL' end as result, check_name, detail
from checks order by ord;

-- The number to watch from here on.
select 'open shortfall' as section, asset, events,
       short_micro,
       round(short_micro / 1e6, 4) as short_units,
       oldest, newest
from public.custody_divergence_open
order by asset;
