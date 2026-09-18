-- 035_fail_stale_withdrawals.sql
-- Mark ramp transactions that never completed as 'failed' (not stuck 'pending').
--
-- A serverless timeout (or any mid-flow death) can leave a ramp tx 'pending'
-- forever: an off-ramp that debited the user but never delivered, or an on-ramp
-- that was initialised but never paid. This RPC reconciles both:
--
--   • withdrawals (off-ramp): mark 'failed' AND refund the debited cNGN — but
--     ONLY when the on-chain send never happened. If the description carries an
--     on-chain tx hash ('… on-chain: 0x…') the cNGN was already sent to the
--     provider (fiat may still be settling), so we leave it for the provider
--     webhook / manual review to avoid double-refunding.
--   • deposits (on-ramp): mark 'failed' after a longer grace (unpaid virtual
--     accounts have long since expired). No balance is touched — a pending
--     deposit has credited nothing.
--
-- Pass p_user_id to reconcile just one user (used inline on their next ramp
-- attempt so a retry self-heals); NULL reconciles everyone (used by the sweep).

CREATE OR REPLACE FUNCTION public.reconcile_stale_transactions(
  p_user_id uuid DEFAULT NULL,
  p_withdrawal_minutes int DEFAULT 20,
  p_deposit_minutes int DEFAULT 90
)
RETURNS jsonb AS $$
DECLARE
  v_rec              record;
  v_failed_wd        int    := 0;
  v_failed_dep       int    := 0;
  v_refunded_micro   bigint := 0;
  v_cngn_micro       bigint;
BEGIN
  -- ── Withdrawals: fail + refund (only where the on-chain send never happened) ──
  FOR v_rec IN
    SELECT id, user_id, amount_kobo
    FROM public.transactions
    WHERE type = 'withdrawal'
      AND status = 'pending'
      AND created_at < now() - make_interval(mins => p_withdrawal_minutes)
      AND COALESCE(description, '') NOT LIKE '%on-chain:%'
      AND (p_user_id IS NULL OR user_id = p_user_id)
    FOR UPDATE SKIP LOCKED
  LOOP
    v_cngn_micro := floor(v_rec.amount_kobo)::bigint * 10000; -- naira*100 → naira*1e6

    UPDATE public.transactions SET status = 'failed' WHERE id = v_rec.id;
    PERFORM public.credit_wallet(v_rec.user_id, 0, v_cngn_micro);

    v_failed_wd      := v_failed_wd + 1;
    v_refunded_micro := v_refunded_micro + v_cngn_micro;
  END LOOP;

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
    'failed_deposits',    v_failed_dep,
    'refunded_micro',     v_refunded_micro
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.reconcile_stale_transactions(uuid, int, int) TO service_role;