-- 039_reconcile_no_false_refund.sql
-- Stop the stale-transaction reconciler from AUTO-REFUNDING off-ramp withdrawals.
--
-- The bug: reconcile_stale_transactions refunded any stale 'pending' withdrawal
-- whose description lacked an on-chain marker. But a withdrawal that ACTUALLY
-- settled on-chain (cNGN sent, bank credited) can also lack the marker if the
-- serverless function died right after the send but before writing status/hash.
-- The reconciler then marked it 'failed' AND credited the balance back — a false
-- refund for money that had already left, inflating the user's wallet.
--
-- The DB alone cannot tell "never sent" from "sent but status-write died". So the
-- reconciler must NOT move money. It only marks the row 'failed' and flags it for
-- manual review. Genuine failures where the cNGN never left custody are already
-- refunded inline by the off-ramp handler's own catch block (which knows the send
-- threw); only ambiguous serverless-death cases reach here, and those need a human
-- to verify on-chain before any refund.

CREATE OR REPLACE FUNCTION public.reconcile_stale_transactions(
  p_user_id uuid DEFAULT NULL,
  p_withdrawal_minutes int DEFAULT 20,
  p_deposit_minutes int DEFAULT 90
)
RETURNS jsonb AS $$
DECLARE
  v_failed_wd   int := 0;
  v_failed_dep  int := 0;
  v_flagged_wd  int := 0;
BEGIN
  -- ── Withdrawals: mark failed + FLAG (never auto-refund) ──────────────────────
  -- Skip ones already flagged. Append a review marker so the operator can find and
  -- verify them (via /api/admin/reconcile-withdrawals) instead of losing money to a
  -- blind refund. On-chain-marked ones ("… on-chain: …") are left alone entirely —
  -- they settled to the provider and get completed, not failed.
  WITH stale AS (
    UPDATE public.transactions t
    SET status = 'failed',
        description = COALESCE(t.description, '') || ' [auto-reconciled: verify on-chain before refund]'
    WHERE t.type = 'withdrawal'
      AND t.status = 'pending'
      AND t.created_at < now() - make_interval(mins => p_withdrawal_minutes)
      AND COALESCE(t.description, '') NOT LIKE '%on-chain:%'
      AND COALESCE(t.description, '') NOT LIKE '%auto-reconciled%'
      AND (p_user_id IS NULL OR t.user_id = p_user_id)
    RETURNING 1
  )
  SELECT count(*) INTO v_failed_wd FROM stale;
  v_flagged_wd := v_failed_wd;

  -- ── Deposits: fail (no refund — nothing was credited) after a longer grace ────
  UPDATE public.transactions
  SET status = 'failed'
  WHERE type = 'deposit'
    AND status = 'pending'
    AND created_at < now() - make_interval(mins => p_deposit_minutes)
    AND (p_user_id IS NULL OR user_id = p_user_id);
  GET DIAGNOSTICS v_failed_dep = ROW_COUNT;

  RETURN jsonb_build_object(
    'failed_withdrawals', v_failed_wd,
    'flagged_for_review', v_flagged_wd,
    'failed_deposits',    v_failed_dep,
    'refunded_micro',     0
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.reconcile_stale_transactions(uuid, int, int) TO service_role;