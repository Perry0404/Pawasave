-- ============================================================
-- Migration 006: Signup reliability + transaction PIN fields
-- Run in Supabase SQL Editor
-- ============================================================

-- Ensure required crypto extension exists for digest() usage.
create extension if not exists pgcrypto;

alter table public.profiles
  add column if not exists transaction_pin_hash text,
  add column if not exists pin_set_at timestamptz;

-- Recreate signup trigger function to avoid insert failures when new fields are present.
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (
    id,
    phone,
    display_name,
    transaction_pin_hash,
    pin_set_at
  )
  values (
    new.id,
    new.phone,
    coalesce(new.raw_user_meta_data->>'display_name', ''),
    nullif(new.raw_user_meta_data->>'transaction_pin_hash', ''),
    case
      when nullif(new.raw_user_meta_data->>'transaction_pin_hash', '') is null then null
      else now()
    end
  );

  insert into public.wallets (
    user_id,
    deposit_address
  )
  values (
    new.id,
    generate_deposit_address(new.id)
  )
  on conflict (user_id) do nothing;

  return new;
end;
$$ language plpgsql security definer;