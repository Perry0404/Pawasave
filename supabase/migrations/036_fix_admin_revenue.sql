-- 036_fix_admin_revenue.sql
-- Purge phantom revenue from broken test transactions and make the admin
-- dashboard compute REAL numbers.
--
-- What was wrong:
--   1) platform_fees accumulated fees for ramp transactions that FAILED or never
--      completed. The old on-ramp code booked its fee at *initialise* (before the
--      user ever paid), and countless test off-ramps left fee rows behind. So both
--      "Total Revenue" (admin_fee_summary = SUM(platform_fees)) and the withdrawable
--      counter (platform_revenue_kobo, bumped by record_platform_fee) were inflated
--      by revenue that never existed.
--   2) admin_tx_volume.total_tx_count = COUNT(*) over EVERY transaction row —
--      including failed/pending test attempts — so "Total Transactions" was noise.
--   3) Operator revenue withdrawals could not be ledgered: the withdraw route writes
--      an audit row with fee_type 'admin_revenue_withdrawal', which the CHECK
--      constraint rejected, so it silently vanished and the counter could never be
--      reconciled against payouts.
--
-- After this migration the numbers are derived only from real, completed activity,
-- and the app already books fees ONLY on completion (on-ramp webhook, off-ramp send),
-- so they cannot re-inflate.

BEGIN;

-- 1) Allow the admin-withdrawal audit row (a negative fee) the withdraw route writes,
--    so future operator payouts are properly ledgered and net out of the counter.
ALTER TABLE public.platform_fees DROP CONSTRAINT IF EXISTS platform_fees_fee_type_check;
ALTER TABLE public.platform_fees ADD CONSTRAINT platform_fees_fee_type_check
  CHECK (fee_type IN ('ramp_onramp', 'ramp_offramp', 'vault_lock_penalty', 'admin_revenue_withdrawal'));

-- 2) Off-ramp withdrawals that were already settled on-chain (cNGN sent to the
--    provider) but left 'pending' because Flipeet's callback never fired — the fiat
--    was delivered, so mark them completed. MUST run BEFORE the phantom-fee purge so
--    a real off-ramp's fee isn't mistaken for phantom.
UPDATE public.transactions
SET status = 'completed'
WHERE type = 'withdrawal'
  AND status = 'pending'
  AND COALESCE(description, '') LIKE '%on-chain:%';

-- 3) Delete phantom ramp fees — any on/off-ramp fee with no matching COMPLETED
--    transaction. Penalty fees (always tied to a real early withdrawal) and any
--    admin-withdrawal audit rows are left untouched.
DELETE FROM public.platform_fees f
WHERE f.fee_type IN ('ramp_onramp', 'ramp_offramp')
  AND NOT EXISTS (
    SELECT 1 FROM public.transactions t
    WHERE t.reference = f.transaction_ref
      AND t.status = 'completed'
  );

-- 4) Recompute the withdrawable revenue counter from the cleaned ledger. Net = real
--    fees earned MINUS operator withdrawals (negative rows) — both now live in
--    platform_fees, so a single SUM is the source of truth.
INSERT INTO public.platform_settings (key, value, description)
VALUES ('platform_revenue_kobo',
        (SELECT COALESCE(SUM(fee_amount_kobo), 0)::text FROM public.platform_fees),
        'Withdrawable platform revenue (kobo)')
ON CONFLICT (key) DO UPDATE
  SET value = (SELECT COALESCE(SUM(fee_amount_kobo), 0)::text FROM public.platform_fees);

COMMIT;

-- 5) Total Revenue = lifetime EARNED (the three real earning types only, so a payout
--    row doesn't shrink lifetime revenue). Only real fees remain after step 3.
CREATE OR REPLACE FUNCTION public.admin_fee_summary()
RETURNS TABLE (
  total_fees_kobo bigint,
  total_onramp_fees bigint,
  total_offramp_fees bigint,
  total_penalty_fees bigint,
  fee_count bigint,
  today_fees_kobo bigint,
  this_month_fees_kobo bigint
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    COALESCE(SUM(fee_amount_kobo), 0),
    COALESCE(SUM(CASE WHEN fee_type = 'ramp_onramp' THEN fee_amount_kobo ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN fee_type = 'ramp_offramp' THEN fee_amount_kobo ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN fee_type = 'vault_lock_penalty' THEN fee_amount_kobo ELSE 0 END), 0),
    COUNT(*)::bigint,
    COALESCE(SUM(CASE WHEN created_at::date = current_date THEN fee_amount_kobo ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN date_trunc('month', created_at) = date_trunc('month', current_date) THEN fee_amount_kobo ELSE 0 END), 0)
  FROM public.platform_fees
  WHERE fee_type IN ('ramp_onramp', 'ramp_offramp', 'vault_lock_penalty');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 6) Total Transactions = settled (completed) only; failed/pending test rows no longer
--    inflate the count. The volume sums already filter to completed.
CREATE OR REPLACE FUNCTION public.admin_tx_volume()
RETURNS TABLE (
  total_deposits_kobo bigint,
  total_withdrawals_kobo bigint,
  total_vault_saves_kobo bigint,
  total_tx_count bigint,
  pending_count bigint
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    COALESCE(SUM(CASE WHEN type = 'deposit' AND status = 'completed' THEN amount_kobo ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN type = 'withdrawal' AND status = 'completed' THEN amount_kobo ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN type = 'save_to_vault' AND status = 'completed' THEN amount_kobo ELSE 0 END), 0),
    (SELECT COUNT(*) FROM public.transactions WHERE status = 'completed')::bigint,
    (SELECT COUNT(*) FROM public.transactions WHERE status = 'pending')::bigint
  FROM public.transactions;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 7) Recent fees list should show only real earning events, not withdrawal audit rows.
CREATE OR REPLACE FUNCTION public.admin_recent_fees(p_limit int DEFAULT 50)
RETURNS TABLE (
  id uuid,
  user_id uuid,
  transaction_ref text,
  fee_type text,
  gross_amount_kobo bigint,
  fee_amount_kobo bigint,
  fee_percent numeric,
  created_at timestamptz
) AS $$
BEGIN
  RETURN QUERY
  SELECT f.id, f.user_id, f.transaction_ref, f.fee_type,
         f.gross_amount_kobo, f.fee_amount_kobo, f.fee_percent, f.created_at
  FROM public.platform_fees f
  WHERE f.fee_type IN ('ramp_onramp', 'ramp_offramp', 'vault_lock_penalty')
  ORDER BY f.created_at DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;