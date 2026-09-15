-- Minimal stand-in for the prod objects APPLY-073-074.sql touches, for local testing
-- against a throwaway postgres. system_locks is deliberately created WITHOUT a unique key
-- on `key`, which is the worst case we cannot rule out in production, since migration 054
-- that created it is not in the repo.

-- Roles are cluster-wide, so they survive dropping the database.
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I', r);
    end if;
  end loop;
end $$;

create table public.system_locks (
  key          text not null,
  locked_until timestamptz not null default now()
);

-- cNGN balances live in wallets.usdc_balance_micro, see migration 063.
create table public.wallets (
  user_id            uuid primary key,
  usdc_balance_micro bigint not null default 0,
  updated_at         timestamptz not null default now()
);

create table public.portfolio_holdings (
  id                  bigserial primary key,
  user_id             uuid not null,
  symbol              text not null,
  asset_type          text not null check (asset_type in ('tokenized_stock', 'pre_ipo')),
  provider            text not null,
  invested_cngn_micro bigint not null default 0,
  shares              numeric not null default 0,
  updated_at          timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  unique (user_id, symbol, provider)
);

create table public.equity_orders (
  id                bigserial primary key,
  user_id           uuid not null,
  symbol            text not null,
  asset_type        text not null check (asset_type in ('tokenized_stock', 'pre_ipo')),
  provider          text not null,
  amount_cngn_micro bigint not null check (amount_cngn_micro > 0),
  usdc_micro        bigint,
  shares            numeric,
  broker_ref        text,
  status            text not null default 'pending'
                    check (status in ('pending', 'filled', 'failed', 'refunded')),
  error             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- reference has no unique index in production, which 075 relies on not assuming.
create table public.transactions (
  id                bigserial primary key,
  user_id           uuid not null,
  type              text not null,
  direction         text not null,
  amount_kobo       bigint,
  amount_usdc_micro bigint,
  description       text,
  reference         text,
  status            text,
  metadata          jsonb,
  created_at        timestamptz not null default now()
);

create table public.equity_sales (
  id               bigserial primary key,
  user_id          uuid not null,
  symbol           text not null,
  provider         text not null,
  shares           numeric not null check (shares > 0),
  usdc_micro       bigint,
  cngn_gross_micro bigint,
  fee_micro        bigint,
  cngn_net_micro   bigint,
  broker_ref       text,
  status           text not null default 'pending'
                   check (status in ('pending', 'settling', 'filled', 'failed')),
  error            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
