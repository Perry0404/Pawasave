-- 101_transactions_metadata.sql
--
-- Records a column that already exists in production but was never in a migration.
--
-- ORDERING: on a from-scratch rebuild this must run BEFORE 063, whose backfill INSERT writes
-- transactions.metadata. Applying 001..100 into an empty Postgres fails at 063 line 104 with
-- "column metadata of relation transactions does not exist", which is how this was found.
--
-- transactions.metadata is written by circle_contribute (085), the pawa_* order functions (086)
-- and the equity ledger backfill (063), and read wherever a transaction's channel or symbol is
-- shown. Nothing creates it. It was added by hand in the dashboard, like create_ajo_invite and
-- the p_user_consent_accepted parameter, neither of which is in version control either.
--
-- Safe on production: ADD COLUMN IF NOT EXISTS on a column that is already there is a no-op.

ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS metadata jsonb;

COMMENT ON COLUMN public.transactions.metadata IS
  'Free-form context for a ledger row: channel, symbol, circle_id, note. Written by '
  'circle_contribute, the pawa_* order functions and the equity backfill. Added out of band '
  'originally; recorded by 101.';
