-- 087_admin_volume_transfers.sql
-- Fold free P2P transfers into transaction volume.
--
-- P2P sends (083) already write a `transfer_out` row for the sender with
-- amount_kobo populated (both the direct path and the claim path). They were
-- simply invisible to admin_tx_volume, which only summed deposit/withdrawal/
-- vault/loan/investment types. This adds a `total_transfers_kobo` column.
--
-- We count the SEND leg only (`transfer_out`, completed), never `transfer_in`,
-- so value that moved from A→B is counted once — not doubled by also summing
-- the credit leg. Pawa merchant payments (086) settle through `pawa_pay`, so
-- those are folded in here too (same "money moved" throughput measure).
-- Output adds one column; all existing columns keep their meaning and order,
-- so nothing else in the dashboard breaks.

DROP FUNCTION IF EXISTS public.admin_tx_volume();
CREATE OR REPLACE FUNCTION public.admin_tx_volume()
RETURNS TABLE (
  total_deposits_kobo bigint, total_withdrawals_kobo bigint, total_vault_saves_kobo bigint,
  total_loans_disbursed_kobo bigint, total_loans_repaid_kobo bigint,
  total_investments_kobo bigint,
  total_transfers_kobo bigint,
  total_tx_count bigint, pending_count bigint
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    COALESCE(SUM(CASE WHEN type = 'deposit'           AND status = 'completed' THEN amount_kobo ELSE 0 END), 0)::bigint,
    COALESCE(SUM(CASE WHEN type = 'withdrawal'        AND status = 'completed' THEN amount_kobo ELSE 0 END), 0)::bigint,
    COALESCE(SUM(CASE WHEN type = 'save_to_vault'     AND status = 'completed' THEN amount_kobo ELSE 0 END), 0)::bigint,
    COALESCE(SUM(CASE WHEN type = 'loan_disbursement' AND status = 'completed' THEN amount_kobo ELSE 0 END), 0)::bigint,
    COALESCE(SUM(CASE WHEN type = 'loan_repayment'    AND status = 'completed' THEN amount_kobo ELSE 0 END), 0)::bigint,
    -- Buys carry the invested amount in amount_kobo; sells carry the net cNGN in amount_usdc_micro.
    COALESCE(SUM(CASE WHEN type = 'investment'  AND status = 'completed' THEN amount_kobo
                      WHEN type = 'equity_sell' AND status = 'completed' THEN FLOOR(amount_usdc_micro / 10000)
                      ELSE 0 END), 0)::bigint,
    -- Free P2P transfers + Pawa merchant payments — count the send/pay leg once.
    -- These carry the value in amount_kobo (kobo); amount_usdc_micro is the 6dp mirror.
    COALESCE(SUM(CASE WHEN type IN ('transfer_out','pawa_pay') AND status = 'completed'
                      THEN amount_kobo ELSE 0 END), 0)::bigint,
    (SELECT COUNT(*) FROM public.transactions WHERE status = 'completed')::bigint,
    (SELECT COUNT(*) FROM public.transactions WHERE status = 'pending')::bigint
  FROM public.transactions;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.admin_tx_volume() TO service_role;
