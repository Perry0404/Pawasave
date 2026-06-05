-- Migration 025: flexible savings pool positions tracking
-- Tracks each user's cNGN deposited into PawasaveLend for flexible savings.
-- psNGN shares are held by the PawaSave custody wallet on behalf of all users.
-- This table records each user's portion of the pool.

CREATE TABLE IF NOT EXISTS flexible_pool_positions (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  cngn_deposited_micro    BIGINT NOT NULL DEFAULT 0,
  last_supply_tx          TEXT,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id)
);

ALTER TABLE flexible_pool_positions ENABLE ROW LEVEL SECURITY;

-- Users can read their own position
CREATE POLICY "user_read_own" ON flexible_pool_positions
  FOR SELECT USING (auth.uid() = user_id);

-- Service role for all operations
CREATE POLICY "service_write" ON flexible_pool_positions
  FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- RPC: get user's current flexible savings value (live from PawasaveLend exchange rate)
-- Called by the dashboard to show accurate cNGN value including yield
CREATE OR REPLACE FUNCTION get_flexible_pool_value(p_user_id UUID)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_deposited BIGINT;
BEGIN
  SELECT COALESCE(cngn_deposited_micro, 0)
  INTO v_deposited
  FROM flexible_pool_positions
  WHERE user_id = p_user_id;

  -- Returns the deposited amount — the frontend calls PawasaveLend.exchangeRate()
  -- on-chain to get the live yield-adjusted value
  RETURN COALESCE(v_deposited, 0);
END;
$$;

-- RPC: record a withdrawal reduction from the pool
CREATE OR REPLACE FUNCTION reduce_flexible_pool(p_user_id UUID, p_cngn_micro BIGINT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE flexible_pool_positions
  SET cngn_deposited_micro = GREATEST(0, cngn_deposited_micro - p_cngn_micro),
      updated_at = NOW()
  WHERE user_id = p_user_id;
END;
$$;
