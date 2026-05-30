-- 022_fixed_savings_rates.sql
-- Implement tiered interest rates for fixed savings based on lock-up duration
-- Total APY: 49.7% annualized
-- Duration-specific rates are pro-rated from the 49.7% annual rate
-- 30 days: 4.14% | 90 days: 12.41% | 180 days: 24.82% | 365 days: 49.7%

-- Table to store fixed savings rates by duration
CREATE TABLE IF NOT EXISTS public.fixed_savings_rates (
  id BIGSERIAL PRIMARY KEY,
  duration_days INTEGER NOT NULL UNIQUE,
  effective_rate_percent NUMERIC(5,2) NOT NULL,
  description TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT rates_valid CHECK (effective_rate_percent > 0 AND effective_rate_percent <= 100)
);

-- Seed default rates (all pro-rated from 49.7% annual)
INSERT INTO public.fixed_savings_rates (duration_days, effective_rate_percent, description)
VALUES
  (30, 4.14, '30-day lock'),
  (90, 12.41, '90-day lock'),
  (180, 24.82, '180-day lock'),
  (365, 49.7, '1-year lock')
ON CONFLICT (duration_days) DO NOTHING;

-- RPC to get effective rate for a given duration
CREATE OR REPLACE FUNCTION public.get_fixed_savings_rate(p_duration_days INTEGER)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_rate NUMERIC;
BEGIN
  -- Find exact match or next-higher duration rate
  SELECT effective_rate_percent INTO v_rate
  FROM public.fixed_savings_rates
  WHERE duration_days >= p_duration_days
  ORDER BY duration_days ASC
  LIMIT 1;
  
  RETURN COALESCE(v_rate, 49.7); -- Default to annual if duration exceeds all tiers
END;
$$;

-- Update savings_locks to store the effective rate at lock time (for audit)
ALTER TABLE public.savings_locks
ADD COLUMN IF NOT EXISTS effective_rate_at_creation NUMERIC(5,2);

-- RPC to calculate interest based on locked amount and effective rate
CREATE OR REPLACE FUNCTION public.calculate_lock_interest(
  p_principal_usdc_micro BIGINT,
  p_effective_rate_percent NUMERIC
)
RETURNS BIGINT
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_interest_micro BIGINT;
BEGIN
  -- Simple interest: Principal * Rate% / 100
  -- Result in micro (multiply by 1_000_000)
  v_interest_micro := (p_principal_usdc_micro * p_effective_rate_percent::BIGINT) / 100;
  
  RETURN v_interest_micro;
END;
$$;

-- Index for faster rate lookups
CREATE INDEX IF NOT EXISTS idx_savings_rates_duration ON public.fixed_savings_rates(duration_days);
