-- ============================================================
-- Migration 011: Esusu Yield Pool (XEND Money Market 33% APY)
--
-- Esusu pot funds are deposited into XEND Money Market as each
-- member contributes.  On payout the accumulated yield (33% APY)
-- is credited to the recipient on top of the base pot amount.
--
-- Requires a dedicated XEND proxy member for the Esusu pool:
--   Set XEND_ESUSU_POOL_MEMBER_ID in Vercel env vars.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- PART A: Track XEND MM position per group (resets each cycle)
-- ────────────────────────────────────────────────────────────

ALTER TABLE public.esusu_groups
  ADD COLUMN IF NOT EXISTS xend_mm_usdc_micro     BIGINT      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS xend_mm_cycle_start_at  TIMESTAMPTZ;

-- ────────────────────────────────────────────────────────────
-- PART B: esusu_record_mm_deposit
-- Called (server-side) after each contribution is deposited
-- into the Esusu pool XEND proxy member wallet.
-- Atomically increments the group's tracked position.
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.esusu_record_mm_deposit(
  p_group_id   uuid,
  p_usdc_micro bigint
) RETURNS void AS $$
BEGIN
  UPDATE public.esusu_groups
  SET xend_mm_usdc_micro     = xend_mm_usdc_micro + p_usdc_micro,
      -- Record start timestamp only on first deposit of this cycle
      xend_mm_cycle_start_at = COALESCE(xend_mm_cycle_start_at, now())
  WHERE id = p_group_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.esusu_record_mm_deposit(uuid, bigint) TO service_role;

-- ────────────────────────────────────────────────────────────
-- PART C: esusu_claim_mm_position
-- Called at payout time (server-side only).
-- Returns the deposited USDC + estimated yield at 33% APY.
-- Resets xend_mm_usdc_micro to 0 so the next cycle starts fresh.
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.esusu_claim_mm_position(
  p_group_id uuid
) RETURNS jsonb AS $$
DECLARE
  v_usdc_micro   bigint;
  v_start_at     timestamptz;
  v_days         numeric;
  v_yield_micro  bigint;
BEGIN
  SELECT xend_mm_usdc_micro, xend_mm_cycle_start_at
  INTO v_usdc_micro, v_start_at
  FROM public.esusu_groups
  WHERE id = p_group_id
  FOR UPDATE;

  IF v_usdc_micro IS NULL OR v_usdc_micro = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_position');
  END IF;

  -- Days since first deposit in this cycle
  v_days := EXTRACT(EPOCH FROM (now() - COALESCE(v_start_at, now()))) / 86400.0;

  -- Estimated yield at 33% APY
  v_yield_micro := floor(v_usdc_micro * 0.33 / 365.0 * GREATEST(v_days, 0));

  -- Reset for next cycle
  UPDATE public.esusu_groups
  SET xend_mm_usdc_micro    = 0,
      xend_mm_cycle_start_at = NULL
  WHERE id = p_group_id;

  RETURN jsonb_build_object(
    'ok',                   true,
    'deposited_usdc_micro', v_usdc_micro,
    'yield_usdc_micro',     v_yield_micro,
    'total_usdc_micro',     v_usdc_micro + v_yield_micro,
    'days',                 round(v_days::numeric, 2)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.esusu_claim_mm_position(uuid) TO service_role;
