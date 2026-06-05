-- Migration 024: vault harvest tracking + distribute_vault_yield RPC

CREATE TABLE IF NOT EXISTS vault_harvests (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tx_hash              TEXT NOT NULL UNIQUE,
  total_yield_micro    BIGINT NOT NULL DEFAULT 0,
  platform_fee_micro   BIGINT NOT NULL DEFAULT 0,
  user_yield_micro     BIGINT NOT NULL DEFAULT 0,
  harvested_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE vault_harvests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_only" ON vault_harvests
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

ALTER TABLE savings_locks
  ADD COLUMN IF NOT EXISTS accrued_yield_micro BIGINT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_savings_locks_active
  ON savings_locks (status) WHERE status = 'active';

CREATE OR REPLACE FUNCTION distribute_vault_yield(p_yield_micro BIGINT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_total_locked BIGINT;
  v_distributed  BIGINT := 0;
  v_lock         RECORD;
  v_share        BIGINT;
BEGIN
  IF p_yield_micro <= 0 THEN
    RETURN jsonb_build_object('distributed', 0, 'locks_updated', 0);
  END IF;

  SELECT COALESCE(SUM(amount_usdc_micro), 0) INTO v_total_locked
  FROM savings_locks WHERE status = 'active';

  IF v_total_locked = 0 THEN
    RETURN jsonb_build_object('distributed', 0, 'reason', 'no_active_locks');
  END IF;

  FOR v_lock IN
    SELECT id, amount_usdc_micro FROM savings_locks WHERE status = 'active'
  LOOP
    v_share := (v_lock.amount_usdc_micro::NUMERIC * p_yield_micro / v_total_locked)::BIGINT;
    IF v_share > 0 THEN
      UPDATE savings_locks
      SET accrued_yield_micro = COALESCE(accrued_yield_micro, 0) + v_share
      WHERE id = v_lock.id;
      v_distributed := v_distributed + v_share;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('distributed', v_distributed, 'total_locked', v_total_locked);
END;
$$;
