-- ============================================================
-- Migration 015: Auto-contribution scheduling for Savings Goals
--
-- Adds:
--   A. auto_contribute_enabled column on savings_goals (default true)
--   B. auto_contribute_goals() RPC — called daily by cron
--      Finds all active goals due for their next contribution
--      and processes them if the user has sufficient wallet balance.
--      Skips silently on insufficient funds (no partial deductions).
-- ============================================================

-- ── PART A: Add opt-out flag to savings_goals ─────────────────────────────────
ALTER TABLE public.savings_goals
  ADD COLUMN IF NOT EXISTS auto_contribute_enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- ── PART B: auto_contribute_goals() RPC ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.auto_contribute_goals()
RETURNS jsonb AS $$
DECLARE
  v_rec             record;
  v_wallet_usdc     bigint;
  v_contributed     int := 0;
  v_skipped_balance int := 0;
  v_skipped_total   int := 0;
BEGIN
  FOR v_rec IN
    SELECT
      g.id,
      g.user_id,
      g.frequency,
      g.contribution_usdc_micro,
      g.contribution_naira_kobo,
      g.last_contributed_at,
      g.started_at
    FROM public.savings_goals g
    WHERE g.status = 'active'
      AND g.auto_contribute_enabled = TRUE
      AND g.saved_usdc_micro < g.target_usdc_micro
      AND (
        -- Daily: last contribution was more than ~23h ago (allows cron drift)
        (g.frequency = 'daily'
          AND COALESCE(g.last_contributed_at, g.started_at - interval '1 day')
              < now() - interval '23 hours')
        OR
        -- Weekly: last contribution was more than ~6d 23h ago
        (g.frequency = 'weekly'
          AND COALESCE(g.last_contributed_at, g.started_at - interval '7 days')
              < now() - interval '6 days 23 hours')
        OR
        -- Monthly: last contribution was more than ~29d 23h ago
        (g.frequency = 'monthly'
          AND COALESCE(g.last_contributed_at, g.started_at - interval '30 days')
              < now() - interval '29 days 23 hours')
      )
    FOR UPDATE SKIP LOCKED
  LOOP
    -- Check wallet balance
    SELECT usdc_balance_micro
    INTO   v_wallet_usdc
    FROM   public.wallets
    WHERE  user_id = v_rec.user_id
    FOR UPDATE;

    IF v_wallet_usdc < v_rec.contribution_usdc_micro THEN
      -- Insufficient funds — skip this goal silently
      v_skipped_balance := v_skipped_balance + 1;
      CONTINUE;
    END IF;

    -- Deduct from wallet
    UPDATE public.wallets
    SET usdc_balance_micro  = usdc_balance_micro  - v_rec.contribution_usdc_micro,
        naira_balance_kobo  = GREATEST(0, naira_balance_kobo - v_rec.contribution_naira_kobo),
        updated_at          = now()
    WHERE user_id = v_rec.user_id;

    -- Credit goal
    UPDATE public.savings_goals
    SET saved_usdc_micro    = saved_usdc_micro    + v_rec.contribution_usdc_micro,
        saved_naira_kobo    = saved_naira_kobo    + v_rec.contribution_naira_kobo,
        last_contributed_at = now()
    WHERE id = v_rec.id;

    -- Audit transaction
    INSERT INTO public.transactions (
      user_id, type, direction, amount_kobo, amount_usdc_micro, description, status
    ) VALUES (
      v_rec.user_id,
      'goal_contribute',
      'debit',
      v_rec.contribution_naira_kobo,
      v_rec.contribution_usdc_micro,
      'Auto contribution (' || v_rec.frequency || ' schedule)',
      'completed'
    );

    v_contributed := v_contributed + 1;
  END LOOP;

  v_skipped_total := v_skipped_balance;

  RETURN jsonb_build_object(
    'contributed',       v_contributed,
    'skipped_balance',   v_skipped_balance,
    'total_skipped',     v_skipped_total
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.auto_contribute_goals() TO service_role;

-- ── PART C: RPC to toggle auto-contribute on/off (called from frontend) ───────
CREATE OR REPLACE FUNCTION public.set_goal_auto_contribute(
  p_goal_id uuid,
  p_enabled  boolean
) RETURNS void AS $$
BEGIN
  UPDATE public.savings_goals
  SET auto_contribute_enabled = p_enabled
  WHERE id = p_goal_id
    AND user_id = auth.uid()
    AND status = 'active';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.set_goal_auto_contribute(uuid, boolean) TO authenticated;
