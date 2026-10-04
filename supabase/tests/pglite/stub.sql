CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid primary key);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

CREATE TABLE public.profiles (id uuid primary key references auth.users(id), display_name text not null default '', tag text);
CREATE TABLE public.wallets (user_id uuid unique references public.profiles(id), usdc_balance_micro bigint not null default 0,
  cngn_pool_micro bigint not null default 0, updated_at timestamptz,
  CONSTRAINT wallets_balances_nonneg CHECK (usdc_balance_micro >= 0 AND cngn_pool_micro >= 0));
CREATE TABLE public.transactions (id uuid primary key default gen_random_uuid(), user_id uuid, type text, direction text,
  amount_kobo bigint, amount_usdc_micro bigint, description text, reference text, status text default 'completed', metadata jsonb,
  created_at timestamptz default now());
CREATE UNIQUE INDEX transactions_reference_uniq ON public.transactions(reference) WHERE reference IS NOT NULL;
CREATE TABLE public.platform_settings (key text primary key, value text);
INSERT INTO public.platform_settings VALUES ('platform_revenue_kobo','0');
CREATE TABLE public.revenue_journal (id bigserial primary key, user_id uuid not null references auth.users(id), transaction_id uuid,
  revenue_type text not null, amount_usdc_micro bigint not null, description text, created_at timestamp default now(),
  CONSTRAINT revenue_type_valid CHECK (revenue_type IN ('platform_fee','lock_interest_forfeited','goal_interest_forfeited','yield_spread')));
CREATE TABLE public.esusu_groups (id uuid primary key default gen_random_uuid(), name text, owner_id uuid references public.profiles(id),
  contribution_amount_kobo bigint default 0, cycle_period text default 'monthly', max_members int default 10, status text default 'forming',
  pot_balance_kobo bigint default 0, emergency_pot_kobo bigint default 0, current_cycle int default 0, cycle_started_at timestamptz,
  creator_incentive_percent numeric default 0, circle_type text default 'rotating_ajo', payout_mode text default 'rotating',
  beneficiary_id uuid, settled_at timestamptz, goal_kobo bigint, created_at timestamptz default now());
CREATE TABLE public.esusu_members (id uuid primary key default gen_random_uuid(), group_id uuid references public.esusu_groups(id),
  user_id uuid, payout_position int, has_collected boolean default false, removed boolean default false, amount_owed_kobo bigint default 0);
CREATE TABLE public.esusu_contributions (id uuid primary key default gen_random_uuid(), group_id uuid, member_id uuid, cycle_number int,
  amount_kobo bigint, paid_at timestamptz default now(), created_at timestamptz default now());
CREATE TABLE public.savings_goals (id uuid primary key default gen_random_uuid(), user_id uuid, title text, status text default 'active',
  saved_usdc_micro bigint default 0, target_usdc_micro bigint, saved_naira_kobo bigint default 0, interest_earned_micro bigint not null default 0,
  completed_at timestamptz);
CREATE TABLE public.fixed_savings_rates (duration_days int primary key);
CREATE TABLE public.savings_locks (id uuid primary key default gen_random_uuid(), user_id uuid, amount_usdc_micro bigint, amount_kobo bigint,
  apy_percent numeric, duration_days int, projected_interest_micro bigint, effective_rate_at_creation numeric, unlocks_at timestamptz);
CREATE FUNCTION public.lock_savings(uuid, bigint, bigint, int, numeric) RETURNS uuid LANGUAGE sql AS $$ SELECT null::uuid $$;
