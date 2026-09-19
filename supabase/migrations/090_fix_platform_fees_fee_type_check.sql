-- 090_fix_platform_fees_fee_type_check.sql
-- FIX a production regression: repay_loan can't book interest.
--
-- Migration 052 added fee_type 'loan_interest' to platform_fees AND made repay_loan
-- write a 'loan_interest' fee row on every repayment. But migration 062 later REDEFINED
-- platform_fees_fee_type_check and dropped 'loan_interest' (and 'investment_fee') while
-- adding 'equity_sell'. Result: any loan repayment that has accrued interest fails with
--   new row for relation "platform_fees" violates check constraint "platform_fees_fee_type_check"
-- and the whole repay_loan transaction rolls back — so borrowers cannot repay.
--
-- This restores the FULL union of every fee_type the app actually writes (verified across
-- migrations + frontend), so no fee insert is ever rejected again. Purely widening — safe.

ALTER TABLE public.platform_fees DROP CONSTRAINT IF EXISTS platform_fees_fee_type_check;
ALTER TABLE public.platform_fees ADD CONSTRAINT platform_fees_fee_type_check CHECK (fee_type IN (
  'ramp_onramp', 'ramp_offramp',
  'vault_lock_penalty', 'goal_break_penalty', 'esusu_penalty',
  'xauto_spread', 'yield_spread',
  'admin_revenue_withdrawal',
  'loan_origination', 'loan_interest',
  'investment_fee',
  'equity_buy', 'equity_sell'
));
