-- 022_fixed_savings_apy_tiers.sql
-- Implement tiered APY for fixed savings based on lock-up duration
-- Longer duration = higher APY (90d: 30%, 180d: 49.7%, 365d: 50%)

-- Table to store APY tiers for different durations
CREATE TABLE IF NOT EXISTS public.fixed_savings_apy_tiers (
  id BIGSERIAL PRIMARY KEY,
  duration_days INTEGER NOT NULL UNIQUE,
  apy_percent NUMERIC(5,2) NOT NULL,
  description TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT apy_tiers_apy_valid CHECK (apy_percent > 0 AND apy_percent <= 100)
);

-- Seed default APY tiers
INSERT INTO public.fixed_savings_apy_tiers (duration_days, apy_percent, description)
VALUES
  (90, 30.0, '90-day lock'),
  (180, 49.7, '180-day lock'),
  (365, 50.0, '1-year lock')
ON CONFLICT (duration_days) DO NOTHING;

-- RPC to get APY for a given duration (returns the matching tier or next-higher tier)
CREATE OR REPLACE FUNCTION public.get_fixed_savings_apy(p_duration_days INTEGER)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_apy NUMERIC;
BEGIN
  -- Find exact match or next-higher duration tier
  SELECT apy_percent INTO v_apy
  FROM public.fixed_savings_apy_tiers
  WHERE duration_days >= p_duration_days
  ORDER BY duration_days ASC
  LIMIT 1;
  
  RETURN COALESCE(v_apy, 50.0); -- Default to highest if duration exceeds all tiers
END;
$$;

-- Update goals table to store APY at time of creation (for audit trail)
ALTER TABLE public.goals
ADD COLUMN IF NOT EXISTS apy_percent_at_creation NUMERIC(5,2);

-- RPC to calculate goal interest based on duration and principal
CREATE OR REPLACE FUNCTION public.calculate_goal_interest(
  p_principal_usdc_micro BIGINT,
  p_duration_days INTEGER,
  p_days_elapsed INTEGER DEFAULT 0
)
RETURNS BIGINT
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_apy NUMERIC;
  v_interest_micro BIGINT;
  v_days_to_use INTEGER;
BEGIN
  -- Get APY for this duration
  v_apy := public.get_fixed_savings_apy(p_duration_days);
  
  -- If days_elapsed not provided, assume full period has passed (simple interest)
  v_days_to_use := COALESCE(NULLIF(p_days_elapsed, 0), p_duration_days);
  
  -- Simple interest: Principal * APY% * (Days / 365)
  -- Result in micro (multiply by 1_000_000)
  v_interest_micro := (p_principal_usdc_micro * v_apy::BIGINT * v_days_to_use) / (365 * 100);
  
  RETURN v_interest_micro;
END;
$$;

-- Index for faster tier lookups
CREATE INDEX IF NOT EXISTS idx_apy_tiers_duration ON public.fixed_savings_apy_tiers(duration_days);
