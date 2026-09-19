-- 091_morpho_unwinding_status.sql
-- Add an 'unwinding' claim state to morpho_loan_draws so exactly ONE runner unwinds a
-- given draw. The unwind is atomically claimed (funded/settling → unwinding) before any
-- on-chain action; a second runner (the inline repay path racing the reconcile cron)
-- sees 'unwinding' and skips, so we can never double-repay shares or double-withdraw
-- collateral. A crashed unwind leaves the row 'unwinding'; the reconcile cron re-claims
-- it after a grace period and resumes (per-leg idempotent — see lib/morpho-treasury.ts).

ALTER TABLE public.morpho_loan_draws DROP CONSTRAINT IF EXISTS morpho_loan_draws_status_check;
ALTER TABLE public.morpho_loan_draws ADD CONSTRAINT morpho_loan_draws_status_check
  CHECK (status IN ('pending','funded','settling','failed','unwinding','closed'));
