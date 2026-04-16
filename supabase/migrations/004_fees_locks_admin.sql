-- ============================================================
-- Migration 004: Fees, Savings Locks, Admin, and RLS fixes
-- Run this ENTIRE script in Supabase SQL Editor
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- PART A: Re-apply RLS recursion fix (safe to re-run)
-- ────────────────────────────────────────────────────────────

create or replace function public.is_group_member(p_group_id uuid)
returns boolean as $$
  select exists (
    select 1 from public.esusu_members
    where group_id = p_group_id and user_id = auth.uid()
  );
$$ language sql security definer stable;

drop policy if exists "Members read members" on public.esusu_members;
drop policy if exists "Members read groups" on public.esusu_groups;
drop policy if exists "Members read contributions" on public.esusu_contributions;
drop policy if exists "Members insert contributions" on public.esusu_contributions;
drop policy if exists "Members read requests" on public.emergency_requests;
drop policy if exists "Members read votes" on public.emergency_votes;

create policy "Members read members" on public.esusu_members for select using (
  user_id = auth.uid() or is_group_member(group_id)
);

create policy "Members read groups" on public.esusu_groups for select using (
  owner_id = auth.uid() or is_group_member(id)
);

create policy "Members read contributions" on public.esusu_contributions for select using (
  is_group_member(group_id)
);

create policy "Members insert contributions" on public.esusu_contributions for insert with check (
  exists (select 1 from public.esusu_members m where m.id = member_id and m.user_id = auth.uid())
);

create policy "Members read requests" on public.emergency_requests for select using (
  is_group_member(group_id)
);

create policy "Members read votes" on public.emergency_votes for select using (
  exists (
    select 1 from public.emergency_requests r
    where r.id = emergency_votes.request_id
    and is_group_member(r.group_id)
  )
);

-- ────────────────────────────────────────────────────────────
-- PART B: Platform Settings (configurable fees, APY rates)
-- ────────────────────────────────────────────────────────────

create table if not exists public.platform_settings (
  key text primary key,
  value text not null,
  description text,
  updated_at timestamptz not null default now()
);

alter table public.platform_settings enable row level security;
-- Only service role can write; anyone can read settings
create policy "Anyone reads settings" on public.platform_settings for select using (true);

-- Insert default values
insert into public.platform_settings (key, value, description) values
  ('ramp_fee_percent', '1.5', 'PawaSave fee on FlintAPI ramp transactions (%)'),
  ('vault_lock_min_days', '30', 'Minimum lock period in days'),
  ('vault_lock_max_days', '365', 'Maximum lock period in days'),
  ('morpho_apy_percent', '4.0', 'Gauntlet USDC Prime Morpho Vault APY (%)'),
  ('morpho_vault_name', 'Gauntlet USDC Prime', 'Active Morpho vault name'),
  ('admin_emails', '', 'Comma-separated admin email list')
on conflict (key) do nothing;

-- ────────────────────────────────────────────────────────────
-- PART C: Platform Fees ledger
-- ────────────────────────────────────────────────────────────

create table if not exists public.platform_fees (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.profiles(id),
  transaction_ref text not null,
  fee_type text not null check (fee_type in ('ramp_onramp', 'ramp_offramp', 'vault_lock_penalty')),
  gross_amount_kobo bigint not null,
  fee_amount_kobo bigint not null,
  fee_percent numeric(5,2) not null,
  created_at timestamptz not null default now()
);

alter table public.platform_fees enable row level security;
-- Users cannot read fees; only service role / admin functions
create policy "Service role only" on public.platform_fees for select using (false);

-- Index for admin queries
create index if not exists idx_platform_fees_created on public.platform_fees(created_at desc);
create index if not exists idx_platform_fees_type on public.platform_fees(fee_type, created_at desc);

-- ────────────────────────────────────────────────────────────
-- PART D: Savings Locks
-- ────────────────────────────────────────────────────────────

create table if not exists public.savings_locks (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  amount_usdc_micro bigint not null,
  amount_kobo bigint not null,
  apy_percent numeric(5,2) not null,
  duration_days int not null,
  projected_interest_micro bigint not null default 0,
  locked_at timestamptz not null default now(),
  unlocks_at timestamptz not null,
  status text not null default 'active' check (status in ('active', 'matured', 'withdrawn', 'early_withdrawn')),
  matured_at timestamptz,
  withdrawn_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.savings_locks enable row level security;
create policy "Users read own locks" on public.savings_locks for select using (auth.uid() = user_id);
create policy "Users insert own locks" on public.savings_locks for insert with check (auth.uid() = user_id);
create policy "Users update own locks" on public.savings_locks for update using (auth.uid() = user_id);

create index if not exists idx_savings_locks_user on public.savings_locks(user_id, status);
create index if not exists idx_savings_locks_unlocks on public.savings_locks(unlocks_at) where status = 'active';

-- ────────────────────────────────────────────────────────────
-- PART E: RPC — Lock savings (deducts from USDC vault)
-- ────────────────────────────────────────────────────────────

create or replace function public.lock_savings(
  p_user_id uuid,
  p_usdc_micro bigint,
  p_kobo bigint,
  p_duration_days int,
  p_apy numeric
) returns uuid as $$
declare
  w public.wallets%rowtype;
  v_projected bigint;
  v_lock_id uuid;
begin
  -- Check balance
  select * into w from public.wallets where user_id = p_user_id for update;
  if w.usdc_balance_micro < p_usdc_micro then
    raise exception 'Insufficient USDC balance';
  end if;

  -- Calculate projected interest: principal * (apy/100) * (days/365)
  v_projected := floor(p_usdc_micro::numeric * (p_apy / 100.0) * (p_duration_days::numeric / 365.0));

  -- Deduct from vault
  update public.wallets
  set usdc_balance_micro = usdc_balance_micro - p_usdc_micro,
      updated_at = now()
  where user_id = p_user_id;

  -- Create lock record
  insert into public.savings_locks (
    user_id, amount_usdc_micro, amount_kobo, apy_percent, duration_days,
    projected_interest_micro, unlocks_at
  ) values (
    p_user_id, p_usdc_micro, p_kobo, p_apy, p_duration_days,
    v_projected, now() + (p_duration_days || ' days')::interval
  ) returning id into v_lock_id;

  -- Record transaction
  insert into public.transactions (
    user_id, type, direction, amount_kobo, amount_usdc_micro,
    description, status
  ) values (
    p_user_id, 'save_to_vault', 'debit', p_kobo, p_usdc_micro,
    'Locked savings for ' || p_duration_days || ' days at ' || p_apy || '% APY',
    'completed'
  );

  return v_lock_id;
end;
$$ language plpgsql security definer;

-- ────────────────────────────────────────────────────────────
-- PART F: RPC — Withdraw matured lock
-- ────────────────────────────────────────────────────────────

create or replace function public.withdraw_lock(
  p_user_id uuid,
  p_lock_id uuid,
  p_early boolean default false
) returns boolean as $$
declare
  v_lock public.savings_locks%rowtype;
  v_payout bigint;
  v_penalty_kobo bigint := 0;
begin
  select * into v_lock from public.savings_locks
  where id = p_lock_id and user_id = p_user_id and status = 'active'
  for update;

  if not found then
    return false;
  end if;

  if p_early and now() < v_lock.unlocks_at then
    -- Early withdrawal: return principal only, no interest, add 0.5% penalty to fees
    v_payout := v_lock.amount_usdc_micro;
    v_penalty_kobo := floor(v_lock.amount_kobo * 0.005);

    update public.savings_locks
    set status = 'early_withdrawn', withdrawn_at = now()
    where id = p_lock_id;

    -- Record penalty fee
    if v_penalty_kobo > 0 then
      insert into public.platform_fees (user_id, transaction_ref, fee_type, gross_amount_kobo, fee_amount_kobo, fee_percent)
      values (p_user_id, p_lock_id::text, 'vault_lock_penalty', v_lock.amount_kobo, v_penalty_kobo, 0.50);
    end if;
  else
    -- Matured: return principal + projected interest
    v_payout := v_lock.amount_usdc_micro + v_lock.projected_interest_micro;

    update public.savings_locks
    set status = 'withdrawn', matured_at = now(), withdrawn_at = now()
    where id = p_lock_id;
  end if;

  -- Credit wallet
  update public.wallets
  set usdc_balance_micro = usdc_balance_micro + v_payout,
      updated_at = now()
  where user_id = p_user_id;

  -- Record transaction
  insert into public.transactions (
    user_id, type, direction, amount_kobo, amount_usdc_micro,
    description, status
  ) values (
    p_user_id, 'vault_withdraw', 'credit',
    v_lock.amount_kobo,
    v_payout,
    case when p_early
      then 'Early lock withdrawal (no interest)'
      else 'Matured lock withdrawn + ' || v_lock.projected_interest_micro || ' μUSDC interest'
    end,
    'completed'
  );

  return true;
end;
$$ language plpgsql security definer;

-- ────────────────────────────────────────────────────────────
-- PART G: RPC — Record platform fee (called from API routes)
-- ────────────────────────────────────────────────────────────

create or replace function public.record_platform_fee(
  p_user_id uuid,
  p_reference text,
  p_fee_type text,
  p_gross_kobo bigint,
  p_fee_kobo bigint,
  p_fee_percent numeric
) returns void as $$
begin
  insert into public.platform_fees (user_id, transaction_ref, fee_type, gross_amount_kobo, fee_amount_kobo, fee_percent)
  values (p_user_id, p_reference, p_fee_type, p_gross_kobo, p_fee_kobo, p_fee_percent);
end;
$$ language plpgsql security definer;

-- ────────────────────────────────────────────────────────────
-- PART H: Admin views (for admin API to query)
-- ────────────────────────────────────────────────────────────

-- Summary view for admin dashboard
create or replace function public.admin_fee_summary()
returns table (
  total_fees_kobo bigint,
  total_onramp_fees bigint,
  total_offramp_fees bigint,
  total_penalty_fees bigint,
  fee_count bigint,
  today_fees_kobo bigint,
  this_month_fees_kobo bigint
) as $$
begin
  return query
  select
    coalesce(sum(fee_amount_kobo), 0) as total_fees_kobo,
    coalesce(sum(case when fee_type = 'ramp_onramp' then fee_amount_kobo else 0 end), 0) as total_onramp_fees,
    coalesce(sum(case when fee_type = 'ramp_offramp' then fee_amount_kobo else 0 end), 0) as total_offramp_fees,
    coalesce(sum(case when fee_type = 'vault_lock_penalty' then fee_amount_kobo else 0 end), 0) as total_penalty_fees,
    count(*)::bigint as fee_count,
    coalesce(sum(case when created_at::date = current_date then fee_amount_kobo else 0 end), 0) as today_fees_kobo,
    coalesce(sum(case when date_trunc('month', created_at) = date_trunc('month', current_date) then fee_amount_kobo else 0 end), 0) as this_month_fees_kobo
  from public.platform_fees;
end;
$$ language plpgsql security definer;

-- User stats for admin
create or replace function public.admin_user_stats()
returns table (
  total_users bigint,
  total_wallets bigint,
  total_naira_kobo bigint,
  total_usdc_micro bigint,
  total_locked_usdc_micro bigint,
  active_locks bigint
) as $$
begin
  return query
  select
    (select count(*) from public.profiles)::bigint as total_users,
    (select count(*) from public.wallets)::bigint as total_wallets,
    coalesce((select sum(naira_balance_kobo) from public.wallets), 0) as total_naira_kobo,
    coalesce((select sum(usdc_balance_micro) from public.wallets), 0) as total_usdc_micro,
    coalesce((select sum(amount_usdc_micro) from public.savings_locks where status = 'active'), 0) as total_locked_usdc_micro,
    (select count(*) from public.savings_locks where status = 'active')::bigint as active_locks;
end;
$$ language plpgsql security definer;

-- Recent fees for admin table
create or replace function public.admin_recent_fees(p_limit int default 50)
returns table (
  id uuid,
  user_id uuid,
  transaction_ref text,
  fee_type text,
  gross_amount_kobo bigint,
  fee_amount_kobo bigint,
  fee_percent numeric,
  created_at timestamptz
) as $$
begin
  return query
  select f.id, f.user_id, f.transaction_ref, f.fee_type,
         f.gross_amount_kobo, f.fee_amount_kobo, f.fee_percent, f.created_at
  from public.platform_fees f
  order by f.created_at desc
  limit p_limit;
end;
$$ language plpgsql security definer;

-- Transaction volume for admin
create or replace function public.admin_tx_volume()
returns table (
  total_deposits_kobo bigint,
  total_withdrawals_kobo bigint,
  total_vault_saves_kobo bigint,
  total_tx_count bigint,
  pending_count bigint
) as $$
begin
  return query
  select
    coalesce(sum(case when type = 'deposit' and status = 'completed' then amount_kobo else 0 end), 0) as total_deposits_kobo,
    coalesce(sum(case when type = 'withdrawal' and status = 'completed' then amount_kobo else 0 end), 0) as total_withdrawals_kobo,
    coalesce(sum(case when type = 'save_to_vault' and status = 'completed' then amount_kobo else 0 end), 0) as total_vault_saves_kobo,
    count(*)::bigint as total_tx_count,
    (select count(*) from public.transactions where status = 'pending')::bigint as pending_count;
end;
$$ language plpgsql security definer;
