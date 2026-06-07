-- ============================================================
-- Migration 026: Real per-user crypto deposit addresses + cNGN
--                deposit crediting (auto-indexer).
--
-- Replaces the old placeholder deposit_address (sha256 of user id, no key)
-- with HD-derived addresses. Each wallet gets a stable `deposit_index`; the
-- app derives the real Base address from DEPOSIT_WALLET_MNEMONIC at
-- m/44'/60'/0'/0/{deposit_index} and stores it in wallets.deposit_address.
--
-- A scanner credits incoming cNGN transfers to those addresses, so a crypto
-- deposit shows up in the user's balance exactly like a fiat deposit.
--
-- Run this ENTIRE script in the Supabase SQL editor.
-- ============================================================

create extension if not exists pgcrypto;

-- ── 1. Stable per-wallet derivation index ────────────────────────────────────
create sequence if not exists public.wallet_deposit_index_seq start 1;

alter table public.wallets
  add column if not exists deposit_index bigint;

-- Backfill an index for every existing wallet
update public.wallets
set deposit_index = nextval('public.wallet_deposit_index_seq')
where deposit_index is null;

alter table public.wallets
  alter column deposit_index set default nextval('public.wallet_deposit_index_seq');

create unique index if not exists idx_wallets_deposit_index
  on public.wallets(deposit_index);

-- The old placeholder addresses are NOT real wallets — clear them so the app
-- re-derives correct HD addresses. (No funds are ever held at the placeholders.)
update public.wallets set deposit_address = null;

-- ── 2. Crypto deposits ledger (idempotent by tx_key) ─────────────────────────
create table if not exists public.crypto_deposits (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles(id) on delete cascade,
  address           text not null,
  tx_hash           text not null,
  log_index         int  not null default 0,
  tx_key            text not null unique,         -- tx_hash + ':' + log_index
  token             text not null default 'cNGN',
  amount_cngn_micro bigint not null,
  block_number      bigint,
  status            text not null default 'confirmed',
  created_at        timestamptz not null default now()
);

alter table public.crypto_deposits enable row level security;

drop policy if exists "Users read own crypto deposits ledger" on public.crypto_deposits;
create policy "Users read own crypto deposits ledger" on public.crypto_deposits
  for select using (user_id = auth.uid());

create index if not exists idx_crypto_deposits_user on public.crypto_deposits(user_id);

-- ── 3. Scanner cursor (last Base block scanned) ──────────────────────────────
create table if not exists public.deposit_scan_state (
  id         int primary key default 1,
  last_block bigint not null default 0,
  updated_at timestamptz not null default now()
);
insert into public.deposit_scan_state (id, last_block)
  values (1, 0) on conflict (id) do nothing;

-- ── 4. Credit a confirmed cNGN deposit (idempotent) ──────────────────────────
-- Re-denominated model: wallets.usdc_balance_micro now holds the user's cNGN
-- savings balance in micro units (1 cNGN = 1 NGN, 6 decimals).
create or replace function public.credit_crypto_deposit(
  p_user_id           uuid,
  p_amount_cngn_micro bigint,
  p_tx_hash           text,
  p_log_index         int,
  p_address           text,
  p_block             bigint
) returns boolean
language plpgsql security definer as $$
declare
  v_key text := p_tx_hash || ':' || coalesce(p_log_index, 0);
begin
  if p_amount_cngn_micro <= 0 then
    return false;
  end if;

  -- Idempotency — never credit the same on-chain transfer twice
  if exists (select 1 from public.crypto_deposits where tx_key = v_key) then
    return false;
  end if;

  insert into public.crypto_deposits (
    user_id, address, tx_hash, log_index, tx_key, amount_cngn_micro, block_number, status
  ) values (
    p_user_id, p_address, p_tx_hash, coalesce(p_log_index, 0), v_key,
    p_amount_cngn_micro, p_block, 'confirmed'
  );

  update public.wallets
  set usdc_balance_micro = usdc_balance_micro + p_amount_cngn_micro,
      updated_at = now()
  where user_id = p_user_id;

  insert into public.transactions (
    user_id, type, direction, amount_kobo, amount_usdc_micro, description, reference, status
  ) values (
    p_user_id, 'deposit', 'credit',
    floor(p_amount_cngn_micro / 10000),   -- kobo: 1 NGN = 1e6 cNGN micro = 100 kobo
    p_amount_cngn_micro,
    'cNGN deposit (on-chain)', p_tx_hash, 'completed'
  );

  return true;
end;
$$;

-- ── 5. New-user trigger: assign deposit_index, no placeholder address ─────────
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, phone, display_name, transaction_pin_hash, pin_set_at)
  values (
    new.id,
    new.phone,
    coalesce(new.raw_user_meta_data->>'display_name', ''),
    nullif(new.raw_user_meta_data->>'transaction_pin_hash', ''),
    case when nullif(new.raw_user_meta_data->>'transaction_pin_hash', '') is null
         then null else now() end
  );

  -- deposit_index is assigned by its DEFAULT sequence; deposit_address is
  -- derived + stored by the app from DEPOSIT_WALLET_MNEMONIC on first view.
  insert into public.wallets (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$ language plpgsql security definer;

-- ── 6. Persist a derived deposit address (called by the app) ──────────────────
create or replace function public.set_deposit_address(
  p_user_id uuid,
  p_address text
) returns void
language plpgsql security definer as $$
begin
  update public.wallets
  set deposit_address = p_address, updated_at = now()
  where user_id = p_user_id and (deposit_address is null or deposit_address <> p_address);
end;
$$;
