-- seed-staging-users.sql
--
-- STAGING ONLY. Never run this against production.
--
-- Creates six users covering every withdrawal tier and product state the adversarial suite
-- needs to attack. Inserts into auth.users so on_auth_user_created fires and builds the
-- profile and wallet rows the real way, rather than inserting those directly and getting a
-- shape the app would never produce.
--
-- Withdrawal tiers, from enforceWithdrawalKycCap in api/ramp/route.ts:
--   kyc_status = 'verified'                    no cap, full biometric
--   strails_va_account_number set, unverified  the higher tier
--   neither                                    the lite per-withdrawal cap
--
-- Values match what production actually stores, checked rather than guessed. kyc_status is
-- constrained to 'pending' or 'verified', and the tier lives in kyc_tier as none, lite or
-- full. An earlier draft invented kyc_status = 'bvn' and the check constraint rejected it.
--
-- UUIDs are fixed so this is re-runnable and so tests can refer to a known user.
-- Passwords are a fixed bcrypt hash of 'staging-only-password'.

do $$
begin
  if current_setting('server_version_num')::int < 150000 then
    raise exception 'unexpected server version';
  end if;
  -- Refuse to run anywhere that looks like production.
  if exists (select 1 from public.transactions limit 1) then
    raise exception 'this database already has transactions, refusing to seed';
  end if;
end $$;

-- Clean slate for re-runs. Children go first, cascade handles the rest.
delete from public.portfolio_holdings where user_id::text like '00000000-0000-4000-8000-%';
delete from public.savings_locks      where user_id::text like '00000000-0000-4000-8000-%';
delete from public.savings_goals      where user_id::text like '00000000-0000-4000-8000-%';
delete from auth.users                where id::text     like '00000000-0000-4000-8000-%';

insert into auth.users (id, email, encrypted_password, email_confirmed_at, aud, role, raw_user_meta_data)
values
  ('00000000-0000-4000-8000-000000000001', 'lite@staging.test',
   '$2a$10$abcdefghijklmnopqrstuvwxyz012345678901234567890123456789', now(),
   'authenticated', 'authenticated', '{"display_name":"Lite Tier"}'),
  ('00000000-0000-4000-8000-000000000002', 'bvn@staging.test',
   '$2a$10$abcdefghijklmnopqrstuvwxyz012345678901234567890123456789', now(),
   'authenticated', 'authenticated', '{"display_name":"BVN Tier"}'),
  ('00000000-0000-4000-8000-000000000003', 'verified@staging.test',
   '$2a$10$abcdefghijklmnopqrstuvwxyz012345678901234567890123456789', now(),
   'authenticated', 'authenticated', '{"display_name":"Verified Tier"}'),
  ('00000000-0000-4000-8000-000000000004', 'locked@staging.test',
   '$2a$10$abcdefghijklmnopqrstuvwxyz012345678901234567890123456789', now(),
   'authenticated', 'authenticated', '{"display_name":"Has Lock"}'),
  ('00000000-0000-4000-8000-000000000005', 'goal@staging.test',
   '$2a$10$abcdefghijklmnopqrstuvwxyz012345678901234567890123456789', now(),
   'authenticated', 'authenticated', '{"display_name":"Has Goal"}'),
  ('00000000-0000-4000-8000-000000000006', 'equity@staging.test',
   '$2a$10$abcdefghijklmnopqrstuvwxyz012345678901234567890123456789', now(),
   'authenticated', 'authenticated', '{"display_name":"Has Equity"}');

-- KYC posture per tier.
update public.profiles
  set kyc_status = 'pending', kyc_tier = 'none', strails_va_account_number = null
  where id = '00000000-0000-4000-8000-000000000001';

update public.profiles
  set kyc_status = 'pending', kyc_tier = 'lite',
      strails_va_account_number = '9900000002',
      strails_va_account_name = 'BVN Tier',
      strails_va_bank_name = 'Staging Bank',
      bvn_hash = 'staging-fake-bvn-hash-2'
  where id = '00000000-0000-4000-8000-000000000002';

update public.profiles
  set kyc_status = 'verified', kyc_tier = 'full', kyc_verified_at = now(),
      strails_va_account_number = '9900000003',
      strails_va_account_name = 'Verified Tier',
      strails_va_bank_name = 'Staging Bank',
      bvn_hash = 'staging-fake-bvn-hash-3'
  where id = '00000000-0000-4000-8000-000000000003';

-- Spendable balances. 1 NGN = 1 cNGN at 6 decimal places.
update public.wallets set usdc_balance_micro =  5000 * 1000000::bigint where user_id = '00000000-0000-4000-8000-000000000001';
update public.wallets set usdc_balance_micro = 250000 * 1000000::bigint where user_id = '00000000-0000-4000-8000-000000000002';
update public.wallets set usdc_balance_micro = 5000000 * 1000000::bigint where user_id = '00000000-0000-4000-8000-000000000003';
update public.wallets set usdc_balance_micro =  20000 * 1000000::bigint where user_id = '00000000-0000-4000-8000-000000000004';
update public.wallets set usdc_balance_micro =  20000 * 1000000::bigint, cngn_pool_micro = 5000 * 1000000::bigint
  where user_id = '00000000-0000-4000-8000-000000000005';
update public.wallets set usdc_balance_micro =  20000 * 1000000::bigint where user_id = '00000000-0000-4000-8000-000000000006';

-- An active lock, mid-term, so an early exit forfeits interest.
insert into public.savings_locks
  (user_id, amount_usdc_micro, amount_kobo, apy_percent, duration_days,
   projected_interest_micro, locked_at, unlocks_at, status, created_at,
   effective_rate_at_creation, user_consent_accepted)
values
  ('00000000-0000-4000-8000-000000000004', 10000 * 1000000::bigint, 10000 * 100::bigint, 27, 90,
   665 * 1000000::bigint, now() - interval '30 days', now() + interval '60 days', 'active',
   now() - interval '30 days', 27, true);

-- A goal part-funded, so break_savings_goal has something to forfeit.
insert into public.savings_goals
  (user_id, title, target_naira_kobo, target_usdc_micro, frequency,
   contribution_naira_kobo, contribution_usdc_micro, saved_naira_kobo, saved_usdc_micro,
   status, started_at, created_at, auto_contribute_enabled, user_consent_accepted)
values
  ('00000000-0000-4000-8000-000000000005', 'Staging goal', 50000 * 100::bigint, 50000 * 1000000::bigint,
   'weekly', 5000 * 100::bigint, 5000 * 1000000::bigint, 15000 * 100::bigint, 15000 * 1000000::bigint,
   'active', now() - interval '45 days', now() - interval '45 days', true, true);

-- An equity holding, so the sell path has stock to act on.
insert into public.portfolio_holdings
  (user_id, symbol, asset_type, provider, invested_cngn_micro, shares)
values
  ('00000000-0000-4000-8000-000000000006', 'AAPL', 'tokenized_stock', 'base_dex', 5000 * 1000000::bigint, 0.0125);

-- ── What we ended up with ────────────────────────────────────────────────────
select
  u.email,
  coalesce(p.kyc_status, '(none)')                    as kyc_status,
  case
    when p.kyc_status = 'verified'                then 'no cap'
    when p.strails_va_account_number is not null  then 'higher tier'
    else 'lite cap'
  end                                                as withdrawal_tier,
  round(coalesce(w.usdc_balance_micro, 0) / 1e6, 2)   as balance_ngn,
  round(coalesce(w.cngn_pool_micro, 0) / 1e6, 2)      as pool_ngn,
  (select count(*) from public.savings_locks       l where l.user_id = u.id and l.status = 'active') as active_locks,
  (select count(*) from public.savings_goals       g where g.user_id = u.id and g.status = 'active') as active_goals,
  (select count(*) from public.portfolio_holdings  h where h.user_id = u.id)                          as holdings,
  w.deposit_index is not null                        as wallet_built_by_trigger
from auth.users u
left join public.profiles p on p.id = u.id
left join public.wallets  w on w.user_id = u.id
where u.id::text like '00000000-0000-4000-8000-%'
order by u.email;
