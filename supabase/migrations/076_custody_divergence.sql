-- 076_custody_divergence.sql  (run after 075)
--
-- Records the cases where the database made a customer whole but on-chain custody did not
-- match, so the shortfall is a visible number instead of a quiet float leak.
--
-- The case that forced this: a stock buy escrows cNGN into the HyperFX gateway, no solver
-- fills, and the order expires. Refunding the customer is the right call, they got no
-- shares. But the cNGN is sitting in the gateway and only the customer side of that was
-- ever written down. Six of these accumulated 6.38 USDC before anyone noticed, and only
-- because someone went looking on-chain.
--
-- place_tx is the important column. Cancelling a stranded intent order needs the exact Order
-- struct, which is only recoverable by decoding that transaction's calldata.
--
-- Run in the Supabase SQL editor. Safe to run more than once.

create table if not exists public.custody_divergence (
  id                     bigserial primary key,
  kind                   text not null,
  -- What the customer-facing row was, so this can be traced back.
  ref_table              text,
  ref_id                 bigint,
  user_id                uuid,
  -- What custody is short, and in what.
  asset                  text not null check (asset in ('cngn', 'usdc', 'eth')),
  amount_micro           bigint not null check (amount_micro > 0),
  -- The transaction that stranded it. For a HyperFX order this is the placeOrder tx.
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

-- One row per stranding event. A retry of the same order must not create a second row, so
-- the place_tx is the natural key when we have one.
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

-- Mark a shortfall recovered, e.g. after cancelling the intent order and getting the input
-- back. Partial recovery is allowed, the amount is what actually came back.
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

-- What custody is currently short, by asset. This is the number to watch.
create or replace view public.custody_divergence_open as
  select asset,
         count(*)              as events,
         sum(amount_micro)     as short_micro,
         min(created_at)       as oldest,
         max(created_at)       as newest
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
