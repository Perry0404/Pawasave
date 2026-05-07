-- 012_savings_goals.sql
-- Adds target savings goals: locked contributions that earn 33% APY until the target is met.

-- ── Table ────────────────────────────────────────────────────────────────────
CREATE TABLE public.savings_goals (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  UUID        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  title                    TEXT        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 100),
  target_naira_kobo        BIGINT      NOT NULL CHECK (target_naira_kobo > 0),
  target_usdc_micro        BIGINT      NOT NULL CHECK (target_usdc_micro > 0),
  frequency                TEXT        NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly')),
  contribution_naira_kobo  BIGINT      NOT NULL CHECK (contribution_naira_kobo > 0),
  contribution_usdc_micro  BIGINT      NOT NULL CHECK (contribution_usdc_micro > 0),
  saved_naira_kobo         BIGINT      NOT NULL DEFAULT 0,
  saved_usdc_micro         BIGINT      NOT NULL DEFAULT 0,
  interest_earned_micro    BIGINT      NOT NULL DEFAULT 0,
  status                   TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'broken')),
  started_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_contributed_at      TIMESTAMPTZ,
  completed_at             TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.savings_goals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own goals"
  ON public.savings_goals FOR ALL
  USING (auth.uid() = user_id);

CREATE INDEX idx_savings_goals_user_status ON public.savings_goals(user_id, status);

-- ── Extend transactions.type check constraint ─────────────────────────────────
-- Drop the old named constraint and re-add with the two new goal types.
ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
ALTER TABLE public.transactions ADD CONSTRAINT transactions_type_check CHECK (type IN (
  'deposit', 'withdrawal', 'save_to_vault', 'vault_withdraw',
  'esusu_contribute', 'esusu_payout', 'emergency_payout',
  'split_auto_save', 'split_auto_esusu',
  'goal_contribute', 'goal_claim'
));

-- ── RPC: contribute_to_goal ───────────────────────────────────────────────────
-- Locks contribution amount from wallet into the goal. Returns FALSE if balance insufficient.
CREATE OR REPLACE FUNCTION public.contribute_to_goal(
  p_goal_id    UUID,
  p_user_id    UUID,
  p_naira_kobo BIGINT,
  p_usdc_micro BIGINT
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_wallet_usdc BIGINT;
  v_goal_status TEXT;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() != p_user_id THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  SELECT status INTO v_goal_status
  FROM public.savings_goals
  WHERE id = p_goal_id AND user_id = p_user_id;

  IF NOT FOUND            THEN RAISE EXCEPTION 'goal not found'; END IF;
  IF v_goal_status != 'active' THEN RAISE EXCEPTION 'goal is not active'; END IF;

  SELECT usdc_balance_micro INTO v_wallet_usdc
  FROM public.wallets WHERE user_id = p_user_id FOR UPDATE;

  IF v_wallet_usdc < p_usdc_micro THEN RETURN FALSE; END IF;

  UPDATE public.wallets
  SET usdc_balance_micro = usdc_balance_micro - p_usdc_micro,
      naira_balance_kobo = GREATEST(0, naira_balance_kobo - p_naira_kobo)
  WHERE user_id = p_user_id;

  UPDATE public.savings_goals
  SET saved_usdc_micro    = saved_usdc_micro + p_usdc_micro,
      saved_naira_kobo    = saved_naira_kobo + p_naira_kobo,
      last_contributed_at = NOW()
  WHERE id = p_goal_id;

  RETURN TRUE;
END;
$$;

-- ── RPC: complete_savings_goal ────────────────────────────────────────────────
-- Called when target is met. Calculates 33% APY interest, credits wallet, marks goal complete.
-- Returns interest earned (usdc_micro).
CREATE OR REPLACE FUNCTION public.complete_savings_goal(
  p_goal_id UUID,
  p_user_id UUID
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_goal     public.savings_goals%ROWTYPE;
  v_days     NUMERIC;
  v_interest BIGINT;
  v_total    BIGINT;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() != p_user_id THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  SELECT * INTO v_goal
  FROM public.savings_goals
  WHERE id = p_goal_id AND user_id = p_user_id FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'goal not found'; END IF;
  IF v_goal.status != 'active' THEN RAISE EXCEPTION 'goal is not active'; END IF;
  IF v_goal.saved_usdc_micro < v_goal.target_usdc_micro THEN
    RAISE EXCEPTION 'target not yet reached';
  END IF;

  v_days     := GREATEST(1, EXTRACT(EPOCH FROM (NOW() - v_goal.started_at)) / 86400.0);
  v_interest := FLOOR(v_goal.saved_usdc_micro * 0.33 * (v_days / 365.0));
  v_total    := v_goal.saved_usdc_micro + v_interest;

  UPDATE public.wallets
  SET usdc_balance_micro = usdc_balance_micro + v_total,
      naira_balance_kobo = naira_balance_kobo + v_goal.saved_naira_kobo
  WHERE user_id = p_user_id;

  UPDATE public.savings_goals
  SET status               = 'completed',
      interest_earned_micro = v_interest,
      completed_at          = NOW()
  WHERE id = p_goal_id;

  RETURN v_interest;
END;
$$;

-- ── RPC: break_savings_goal ───────────────────────────────────────────────────
-- Early withdrawal: returns principal only (no interest).
CREATE OR REPLACE FUNCTION public.break_savings_goal(
  p_goal_id UUID,
  p_user_id UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_goal public.savings_goals%ROWTYPE;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() != p_user_id THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  SELECT * INTO v_goal
  FROM public.savings_goals
  WHERE id = p_goal_id AND user_id = p_user_id FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'goal not found'; END IF;
  IF v_goal.status != 'active' THEN RAISE EXCEPTION 'goal is not active'; END IF;

  UPDATE public.wallets
  SET usdc_balance_micro = usdc_balance_micro + v_goal.saved_usdc_micro,
      naira_balance_kobo = naira_balance_kobo + v_goal.saved_naira_kobo
  WHERE user_id = p_user_id;

  UPDATE public.savings_goals
  SET status       = 'broken',
      completed_at = NOW()
  WHERE id = p_goal_id;

  RETURN TRUE;
END;
$$;
