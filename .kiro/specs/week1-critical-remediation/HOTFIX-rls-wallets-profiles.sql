-- HOTFIX: RLS is disabled on wallets and profiles in production.
--
-- Both tables have policies defined but rls_enabled = false, so none of them are
-- enforced. anon holds SELECT/UPDATE/INSERT/DELETE on both, and the anon key ships
-- in the client bundle. Every customer balance, deposit address and profile is
-- currently readable and writable by anyone, with no login and no row scoping.
--
-- Run this whole file once in the Supabase SQL Editor. It is a single transaction,
-- so either all of it applies or none of it does. Safe to run more than once.
--
-- The verification block at the end runs after commit and prints a pass/fail table.
-- Then run the smoke tests listed at the bottom.

begin;

-- 1. Turn RLS on. The existing policies are already correct for per-user scoping.
--
-- Safe because service_role has BYPASSRLS so every server route is unaffected,
-- handle_new_user is SECURITY DEFINER so signup still inserts, and the existing
-- SELECT and UPDATE policies scope clients to their own row. Neither table has a
-- DELETE policy, so client deletes become denied, which is what we want.
--
-- This briefly takes an exclusive lock on both tables. It is milliseconds at this
-- table size, but prefer a quiet moment if you have one.
alter table public.wallets  enable row level security;
alter table public.profiles enable row level security;


-- 2. Close the anon path through the PIN trigger.
--
-- The existing trigger only rejects the 'authenticated' role, so an anon-key caller
-- could rewrite transaction_pin_hash and then withdraw as that customer. Step 1
-- already denies anon any matching row, this is defence in depth.
--
-- Only BEFORE UPDATE is affected, so handle_new_user's INSERT is untouched, and
-- service_role still passes so /api/security/pin keeps working.
create or replace function public.protect_transaction_pin()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.transaction_pin_hash is distinct from old.transaction_pin_hash
     and coalesce(auth.role(), '') in ('authenticated', 'anon') then
    raise exception 'Transaction PIN can only be changed through the secure PIN endpoint';
  end if;
  return new;
end;
$$;


-- 3. Revoke execute on dangerous functions that nothing calls.
--
-- All eight currently have anon EXECUTE and zero call sites in the application, so
-- revoking cannot break a live path. Done dynamically by name so overloads and any
-- signature drift are handled, and so a missing function is skipped rather than
-- aborting the transaction.
--
-- The other ~70 open functions are deliberately left alone. The codebase calls some
-- of them with a user session and some with the service role, so a blanket revoke
-- would break withdrawals and refunds. That needs the call-site pass in task 17
-- before the revoke in task 21.4.
do $$
declare
  fn record;
  revoked int := 0;
begin
  for fn in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'admin_verify_kyc',
        'admin_deduct_revenue',
        'submit_kyc',
        'withdraw_from_vault',
        'compound_yield',
        'record_yield_spread',
        'debit_wallet_with_fee',
        'generate_deposit_address'
      )
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn.sig);
    execute format('grant execute on function %s to service_role', fn.sig);
    revoked := revoked + 1;
  end loop;

  raise notice 'locked down % function(s)', revoked;
end;
$$;

commit;


-- Verification. Runs after commit, every row should read PASS.
with checks(check_name, actual, expected) as (
  select
    'wallets RLS enabled',
    (select relrowsecurity from pg_class where oid = 'public.wallets'::regclass)::text,
    'true'
  union all
  select
    'profiles RLS enabled',
    (select relrowsecurity from pg_class where oid = 'public.profiles'::regclass)::text,
    'true'
  union all
  select
    'dead dangerous functions still open to anon',
    (
      select count(*)::text
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and has_function_privilege('anon', p.oid, 'EXECUTE')
        and p.proname in (
          'admin_verify_kyc', 'admin_deduct_revenue', 'submit_kyc',
          'withdraw_from_vault', 'compound_yield', 'record_yield_spread',
          'debit_wallet_with_fee', 'generate_deposit_address'
        )
    ),
    '0'
  union all
  select
    'PIN trigger blocks anon',
    (
      select case when pg_get_functiondef(p.oid) like '%''anon''%' then 'true' else 'false' end
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'protect_transaction_pin'
      limit 1
    ),
    'true'
  union all
  select
    'PIN trigger still attached to profiles',
    (
      select case when count(*) > 0 then 'true' else 'false' end
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      where c.relname = 'profiles'
        and t.tgname = 'trg_protect_transaction_pin'
        and not t.tgisinternal
    ),
    'true'
)
select
  check_name,
  actual,
  expected,
  case when actual = expected then 'PASS' else 'FAIL' end as result
from checks;


-- Smoke tests to run in the app straight after:
--   1. Sign up a new account, confirm profile and wallet rows get created
--   2. Log in as an existing customer, confirm the balance displays
--   3. Set and then change a transaction PIN in Settings
--   4. Small deposit, confirm it credits
--   5. Small withdrawal, confirm it settles
--   6. Load the admin dashboard
--
-- If a read breaks, the cause is a server route using the anon key where it should
-- use the service role. That is a route fix, not a reason to turn RLS back off.
--
-- Rollback if you must, though it reopens the hole:
--   alter table public.wallets  disable row level security;
--   alter table public.profiles disable row level security;


-- What this leaves open, all scheduled in the Week 1 spec:
--   A logged-in customer can still edit their own balance, the UPDATE policy is
--   row-scoped rather than column-scoped. Task 21.1.
--
--   A logged-in customer can still set their own kyc_status, which lifts the
--   withdrawal cap. Task 21.2.
--
--   Around 70 functions still have anon EXECUTE, including credit_wallet and
--   credit_crypto_deposit. Tasks 17 then 21.4.
--
--   All six views still run as owner and bypass RLS, so anon can read platform
--   revenue. Tasks 18 and 19, which must ship together.
