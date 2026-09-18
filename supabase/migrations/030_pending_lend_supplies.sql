-- 030_pending_lend_supplies.sql
-- V2-MED-06 — durable retry queue for failed PawasaveLend supplies.
--
-- When a Flipeet deposit is credited, the webhook fires supplyToLend() to move
-- the cNGN into PawasaveLend for yield. That call is intentionally non-blocking
-- (the user is already credited), so an RPC hiccup means the funds sit idle in
-- custody and never start earning. This table records every supply that failed
-- (or every supply, optionally) so the auto-contribute cron can retry it until
-- it lands, instead of silently dropping yield.
-- Idempotent: safe to run more than once.

CREATE TABLE IF NOT EXISTS public.pending_lend_supplies (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL,
  cngn_micro  BIGINT NOT NULL CHECK (cngn_micro > 0),
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'done', 'failed')),
  attempts    INT  NOT NULL DEFAULT 0,
  last_error  TEXT,
  supply_tx   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Only the cron (service role) touches this; lock it down from anon/auth.
ALTER TABLE public.pending_lend_supplies ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_pending_lend_supplies_status
  ON public.pending_lend_supplies (status, created_at)
  WHERE status = 'pending';

-- Enqueue a supply that needs (re)trying. Called by the webhook on failure.
CREATE OR REPLACE FUNCTION public.enqueue_lend_supply(
  p_user_id    UUID,
  p_cngn_micro BIGINT,
  p_error      TEXT DEFAULT NULL
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_id BIGINT;
BEGIN
  IF p_cngn_micro IS NULL OR p_cngn_micro <= 0 THEN
    RAISE EXCEPTION 'enqueue_lend_supply: amount must be positive';
  END IF;
  INSERT INTO public.pending_lend_supplies (user_id, cngn_micro, last_error)
  VALUES (p_user_id, p_cngn_micro, p_error)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- Fetch a batch of pending supplies for the cron to attempt. Skips rows that
-- have already been retried too many times so a permanently-bad row doesn't
-- block the queue (MAX_ATTEMPTS = 8).
CREATE OR REPLACE FUNCTION public.get_pending_lend_supplies(p_limit INT DEFAULT 20)
RETURNS TABLE (id BIGINT, user_id UUID, cngn_micro BIGINT, attempts INT)
LANGUAGE sql SECURITY DEFINER AS $$
  SELECT id, user_id, cngn_micro, attempts
  FROM public.pending_lend_supplies
  WHERE status = 'pending' AND attempts < 8
  ORDER BY created_at ASC
  LIMIT GREATEST(1, LEAST(p_limit, 100));
$$;

CREATE OR REPLACE FUNCTION public.mark_lend_supply_done(
  p_id BIGINT,
  p_tx TEXT
) RETURNS VOID
LANGUAGE sql SECURITY DEFINER AS $$
  UPDATE public.pending_lend_supplies
  SET status = 'done', supply_tx = p_tx, attempts = attempts + 1, updated_at = now()
  WHERE id = p_id;
$$;

-- Bump attempt count + record error. Once attempts hits the cap, flip to 'failed'
-- so it stops being picked up (surfaces for manual review).
CREATE OR REPLACE FUNCTION public.mark_lend_supply_failed(
  p_id    BIGINT,
  p_error TEXT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE public.pending_lend_supplies
  SET attempts   = attempts + 1,
      last_error = p_error,
      status     = CASE WHEN attempts + 1 >= 8 THEN 'failed' ELSE 'pending' END,
      updated_at = now()
  WHERE id = p_id;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_lend_supply(UUID, BIGINT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_pending_lend_supplies(INT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_lend_supply_done(BIGINT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_lend_supply_failed(BIGINT, TEXT) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.enqueue_lend_supply(UUID, BIGINT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_pending_lend_supplies(INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_lend_supply_done(BIGINT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_lend_supply_failed(BIGINT, TEXT) TO service_role;