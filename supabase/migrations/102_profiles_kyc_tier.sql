-- 102_profiles_kyc_tier.sql
--
-- Records a second column that exists in production but is in no committed migration.
--
-- profiles.kyc_tier is read by three live routes. backend/src/routes/p2p/send/route.ts:75
-- selects it and refuses the send outright when the tier is 'none', so if the column were
-- genuinely missing every send would fail with kyc_required. Sends work, so it exists.
-- ramp/route.ts:1122 says as much and deliberately keys off kyc_status instead, "safe to
-- deploy in any order relative to the migration" — the migration being 058, which is not in
-- this repo.
--
-- WIDER PROBLEM, not solved here. Migrations 046-055 and 057-061 do not exist, and never did:
-- git log --all over supabase/migrations has no trace of them. The chain jumps 045 -> 056 ->
-- 062. So fifteen numbers are unaccounted for, and at least one of them was applied to
-- production by hand. Three known consequences so far, all found by applying 001-100 into an
-- empty Postgres:
--
--   transactions.metadata    written by 063, 085 and 086, created by nothing  (recorded in 101)
--   profiles.kyc_tier        read by three routes, created by nothing         (this file)
--   create_ajo_invite        called by frontend groups-view.tsx:208, defined nowhere
--
-- The repo cannot rebuild the production database. Fixing that means dumping the live schema
-- and diffing it against the chain, which is an ops task and is tracked in the
-- circles-savings-invest-loans spec, not attempted here.
--
-- ORDERING: after 041, which adds the strails_* columns the backfill reads.
--
-- Safe on production: ADD COLUMN IF NOT EXISTS is a no-op where the column is already there,
-- and the backfill only touches rows where the tier is NULL. Deliberately no CHECK constraint,
-- because a constraint added blind would fail on whatever values are already stored.

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS kyc_tier text;

-- Derive a tier for rows that have none, using the documented rules:
--   full  biometric Sense KYC done, which is exactly kyc_status = 'verified'
--   lite  a Naira virtual account exists, so a BVN was accepted
--   none  neither
UPDATE public.profiles
SET kyc_tier = CASE
      WHEN kyc_status = 'verified'                THEN 'full'
      WHEN strails_va_account_number IS NOT NULL  THEN 'lite'
      ELSE 'none'
    END
WHERE kyc_tier IS NULL;

ALTER TABLE public.profiles ALTER COLUMN kyc_tier SET DEFAULT 'none';

COMMENT ON COLUMN public.profiles.kyc_tier IS
  'Withdrawal tier: none (no BVN, per-withdrawal cap), lite (BVN accepted, rolling 24h cap), '
  'full (Sense biometric, uncapped to the hard ceiling). Read by p2p/send, ramp and pawa/pay. '
  'Added out of band originally; recorded by 102.';
