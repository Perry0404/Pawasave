-- 023_revenue_tracking.sql
-- Track consent agreements and revenue breakdown for admin dashboard
-- Includes: platform fees, interest forfeiture, yield spreads

-- Add consent tracking columns to savings_locks
ALTER TABLE public.savings_locks
ADD COLUMN IF NOT EXISTS user_consent_accepted BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS consent_accepted_at TIMESTAMP,
ADD COLUMN IF NOT EXISTS interest_forfeited_usdc_micro BIGINT DEFAULT 0;

-- Add consent tracking to goals
ALTER TABLE public.goals
ADD COLUMN IF NOT EXISTS user_consent_accepted BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS consent_accepted_at TIMESTAMP,
ADD COLUMN IF NOT EXISTS interest_forfeited_usdc_micro BIGINT DEFAULT 0;

-- Table to track all platform revenue sources
CREATE TABLE IF NOT EXISTS public.revenue_journal (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id),
  transaction_id UUID,
  revenue_type TEXT NOT NULL, -- 'platform_fee', 'lock_interest_forfeited', 'goal_interest_forfeited', 'yield_spread'
  amount_usdc_micro BIGINT NOT NULL,
  description TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT revenue_type_valid CHECK (revenue_type IN ('platform_fee', 'lock_interest_forfeited', 'goal_interest_forfeited', 'yield_spread'))
);

-- RPC to record revenue when user forfeits interest on early lock withdrawal
CREATE OR REPLACE FUNCTION public.record_lock_forfeiture(
  p_lock_id BIGINT,
  p_user_id UUID,
  p_forfeited_interest_usdc_micro BIGINT
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  -- Update lock record
  UPDATE public.savings_locks
  SET interest_forfeited_usdc_micro = p_forfeited_interest_usdc_micro
  WHERE id = p_lock_id;
  
  -- Record as revenue
  INSERT INTO public.revenue_journal (user_id, transaction_id, revenue_type, amount_usdc_micro, description)
  VALUES (p_user_id, NULL, 'lock_interest_forfeited', p_forfeited_interest_usdc_micro, 'Interest forfeited from early lock withdrawal');
END;
$$;

-- RPC to record revenue when user forfeits interest on early goal break
CREATE OR REPLACE FUNCTION public.record_goal_forfeiture(
  p_goal_id BIGINT,
  p_user_id UUID,
  p_forfeited_interest_usdc_micro BIGINT
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  -- Update goal record
  UPDATE public.goals
  SET interest_forfeited_usdc_micro = p_forfeited_interest_usdc_micro
  WHERE id = p_goal_id;
  
  -- Record as revenue
  INSERT INTO public.revenue_journal (user_id, transaction_id, revenue_type, amount_usdc_micro, description)
  VALUES (p_user_id, NULL, 'goal_interest_forfeited', p_forfeited_interest_usdc_micro, 'Interest forfeited from breaking goal before target');
END;
$$;

-- RPC to record yield spread revenue (difference between what users earn and what we receive from Xend)
CREATE OR REPLACE FUNCTION public.record_yield_spread(
  p_user_id UUID,
  p_amount_usdc_micro BIGINT,
  p_description TEXT DEFAULT 'Yield spread revenue'
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO public.revenue_journal (user_id, revenue_type, amount_usdc_micro, description)
  VALUES (p_user_id, 'yield_spread', p_amount_usdc_micro, p_description);
END;
$$;

-- Admin view: Daily revenue summary
CREATE OR REPLACE VIEW public.revenue_summary_daily AS
  SELECT
    DATE(created_at) AS date,
    revenue_type,
    COUNT(*) AS count,
    SUM(amount_usdc_micro) AS total_usdc_micro,
    ROUND(SUM(amount_usdc_micro) / 1000000.0, 2) AS total_usdc
  FROM public.revenue_journal
  GROUP BY DATE(created_at), revenue_type
  ORDER BY DATE(created_at) DESC, revenue_type;

-- Admin view: Monthly revenue summary
CREATE OR REPLACE VIEW public.revenue_summary_monthly AS
  SELECT
    DATE_TRUNC('month', created_at)::DATE AS month,
    revenue_type,
    COUNT(*) AS count,
    SUM(amount_usdc_micro) AS total_usdc_micro,
    ROUND(SUM(amount_usdc_micro) / 1000000.0, 2) AS total_usdc
  FROM public.revenue_journal
  GROUP BY DATE_TRUNC('month', created_at), revenue_type
  ORDER BY DATE_TRUNC('month', created_at) DESC, revenue_type;

-- Admin view: Total revenue by type
CREATE OR REPLACE VIEW public.revenue_by_type AS
  SELECT
    revenue_type,
    COUNT(*) AS transaction_count,
    SUM(amount_usdc_micro) AS total_usdc_micro,
    ROUND(SUM(amount_usdc_micro) / 1000000.0, 2) AS total_usdc,
    ROUND(AVG(amount_usdc_micro) / 1000000.0, 4) AS avg_usdc
  FROM public.revenue_journal
  GROUP BY revenue_type
  ORDER BY total_usdc_micro DESC;

-- Admin view: Platform metrics
CREATE OR REPLACE VIEW public.platform_metrics AS
  SELECT
    (SELECT COUNT(DISTINCT id) FROM auth.users) AS total_users,
    (SELECT COUNT(*) FROM public.savings_locks WHERE status = 'active') AS active_locks,
    (SELECT COUNT(*) FROM public.goals WHERE status = 'active') AS active_goals,
    (SELECT COUNT(*) FROM public.transactions WHERE status = 'completed') AS completed_transactions,
    (SELECT ROUND(SUM(amount_usdc_micro) / 1000000.0, 2) FROM public.revenue_journal) AS total_revenue_usdc;

-- Indexes for faster queries
CREATE INDEX IF NOT EXISTS idx_revenue_journal_type ON public.revenue_journal(revenue_type);
CREATE INDEX IF NOT EXISTS idx_revenue_journal_user ON public.revenue_journal(user_id);
CREATE INDEX IF NOT EXISTS idx_revenue_journal_date ON public.revenue_journal(created_at);
CREATE INDEX IF NOT EXISTS idx_savings_locks_consent ON public.savings_locks(user_consent_accepted);
CREATE INDEX IF NOT EXISTS idx_goals_consent ON public.goals(user_consent_accepted);
