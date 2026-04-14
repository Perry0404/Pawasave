-- PawaSave Database Schema
-- Run this in Supabase SQL Editor

-- Enable UUID generation
create extension if not exists "uuid-ossp";

-- ── Profiles ──
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  phone text,
  business_name text not null default '',
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
create policy "Users read own profile" on public.profiles for select using (auth.uid() = id);
create policy "Users update own profile" on public.profiles for update using (auth.uid() = id);
create policy "Users insert own profile" on public.profiles for insert with check (auth.uid() = id);

-- ── Wallets ──
create table public.wallets (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null unique references public.profiles(id) on delete cascade,
  naira_balance_kobo bigint not null default 0,
  usdc_balance_micro bigint not null default 0,
  total_saved_kobo bigint not null default 0,
  total_withdrawn_kobo bigint not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.wallets enable row level security;
create policy "Users read own wallet" on public.wallets for select using (auth.uid() = user_id);
create policy "Users update own wallet" on public.wallets for update using (auth.uid() = user_id);
create policy "Users insert own wallet" on public.wallets for insert with check (auth.uid() = user_id);

-- ── Transactions ──
create table public.transactions (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  type text not null check (type in (
    'deposit', 'withdrawal', 'save_to_vault', 'vault_withdraw',
    'esusu_contribute', 'esusu_payout', 'emergency_payout',
    'split_auto_save', 'split_auto_esusu'
  )),
  direction text not null check (direction in ('credit', 'debit')),
  amount_kobo bigint not null,
  amount_usdc_micro bigint,
  description text not null default '',
  reference text,
  paychant_tx_id text,
  status text not null default 'completed' check (status in ('pending', 'completed', 'failed')),
  created_at timestamptz not null default now()
);

alter table public.transactions enable row level security;
create policy "Users read own txs" on public.transactions for select using (auth.uid() = user_id);
create policy "Users insert own txs" on public.transactions for insert with check (auth.uid() = user_id);

create index idx_transactions_user on public.transactions(user_id, created_at desc);

-- ── Split Rules ──
create table public.split_rules (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  vault_percent int not null default 0 check (vault_percent >= 0 and vault_percent <= 100),
  naira_percent int not null default 100 check (naira_percent >= 0 and naira_percent <= 100),
  esusu_percent int not null default 0 check (esusu_percent >= 0 and esusu_percent <= 100),
  esusu_group_id uuid references public.esusu_groups(id),
  min_amount_kobo bigint not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.split_rules enable row level security;
create policy "Users manage own rules" on public.split_rules for all using (auth.uid() = user_id);

-- ── Esusu Groups ──
create table public.esusu_groups (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  owner_id uuid not null references public.profiles(id),
  contribution_amount_kobo bigint not null,
  cycle_period text not null default 'monthly' check (cycle_period in ('daily','weekly','biweekly','monthly')),
  max_members int not null default 10,
  current_cycle int not null default 0,
  pot_balance_kobo bigint not null default 0,
  emergency_pot_kobo bigint not null default 0,
  status text not null default 'forming' check (status in ('forming','active','completed')),
  created_at timestamptz not null default now()
);

alter table public.esusu_groups enable row level security;
create policy "Members read groups" on public.esusu_groups for select using (
  exists (select 1 from public.esusu_members where group_id = esusu_groups.id and user_id = auth.uid())
  or owner_id = auth.uid()
);
create policy "Owner manages group" on public.esusu_groups for all using (owner_id = auth.uid());

-- ── Esusu Members ──
create table public.esusu_members (
  id uuid primary key default uuid_generate_v4(),
  group_id uuid not null references public.esusu_groups(id) on delete cascade,
  user_id uuid not null references public.profiles(id),
  payout_position int not null default 0,
  joined_at timestamptz not null default now(),
  unique(group_id, user_id)
);

alter table public.esusu_members enable row level security;
create policy "Members read members" on public.esusu_members for select using (
  exists (select 1 from public.esusu_members m where m.group_id = esusu_members.group_id and m.user_id = auth.uid())
);
create policy "Users insert self" on public.esusu_members for insert with check (auth.uid() = user_id);

-- ── Esusu Contributions ──
create table public.esusu_contributions (
  id uuid primary key default uuid_generate_v4(),
  group_id uuid not null references public.esusu_groups(id) on delete cascade,
  member_id uuid not null references public.esusu_members(id),
  cycle_number int not null,
  amount_kobo bigint not null,
  paid_at timestamptz not null default now()
);

alter table public.esusu_contributions enable row level security;
create policy "Members read contributions" on public.esusu_contributions for select using (
  exists (select 1 from public.esusu_members m where m.group_id = esusu_contributions.group_id and m.user_id = auth.uid())
);
create policy "Members insert contributions" on public.esusu_contributions for insert with check (
  exists (select 1 from public.esusu_members m where m.id = member_id and m.user_id = auth.uid())
);

-- ── Emergency Requests ──
create table public.emergency_requests (
  id uuid primary key default uuid_generate_v4(),
  group_id uuid not null references public.esusu_groups(id) on delete cascade,
  requester_id uuid not null references public.profiles(id),
  reason text not null,
  amount_kobo bigint not null,
  status text not null default 'voting' check (status in ('voting','approved','rejected','disbursed')),
  created_at timestamptz not null default now()
);

alter table public.emergency_requests enable row level security;
create policy "Members read requests" on public.emergency_requests for select using (
  exists (select 1 from public.esusu_members m where m.group_id = emergency_requests.group_id and m.user_id = auth.uid())
);
create policy "Members insert requests" on public.emergency_requests for insert with check (auth.uid() = requester_id);

-- ── Emergency Votes ──
create table public.emergency_votes (
  id uuid primary key default uuid_generate_v4(),
  request_id uuid not null references public.emergency_requests(id) on delete cascade,
  voter_id uuid not null references public.profiles(id),
  approve boolean not null,
  voted_at timestamptz not null default now(),
  unique(request_id, voter_id)
);

alter table public.emergency_votes enable row level security;
create policy "Members read votes" on public.emergency_votes for select using (
  exists (
    select 1 from public.emergency_requests r
    join public.esusu_members m on m.group_id = r.group_id
    where r.id = emergency_votes.request_id and m.user_id = auth.uid()
  )
);
create policy "Members insert votes" on public.emergency_votes for insert with check (auth.uid() = voter_id);

-- ── Auto-create profile + wallet on signup ──
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, phone, business_name)
  values (new.id, new.phone, coalesce(new.raw_user_meta_data->>'business_name', ''));
  insert into public.wallets (user_id) values (new.id);
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
