-- 031_admin_login_throttle.sql
-- V2-LOW-04 — brute-force lockout for the admin password endpoint.
--
-- /api/admin/verify only does a constant-time compare, so the single admin
-- password can be guessed at full speed across Vercel's many warm instances. An
-- in-memory counter wouldn't hold across instances; this keeps the throttle in
-- Postgres, keyed by client IP, so it actually bites. Lock after 5 failures for
-- 15 minutes; any success clears the counter. Keyed by IP (not global) so an
-- attacker can't lock the real admin out.
-- Idempotent: safe to run more than once.

CREATE TABLE IF NOT EXISTS public.admin_login_throttle (
  ip           TEXT PRIMARY KEY,
  fail_count   INT NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.admin_login_throttle ENABLE ROW LEVEL SECURITY;

-- Returns locked_until if the IP is currently locked, else NULL.
CREATE OR REPLACE FUNCTION public.admin_login_locked(p_ip TEXT)
RETURNS TIMESTAMPTZ
LANGUAGE sql SECURITY DEFINER AS $$
  SELECT locked_until
  FROM public.admin_login_throttle
  WHERE ip = p_ip AND locked_until IS NOT NULL AND locked_until > now();
$$;

-- Record an attempt. On success: clear. On failure: increment and, at the 5th
-- failure, lock for 15 minutes. Returns the active lock expiry (or NULL).
CREATE OR REPLACE FUNCTION public.admin_login_record(
  p_ip      TEXT,
  p_success BOOLEAN
) RETURNS TIMESTAMPTZ
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_fail   INT;
  v_locked TIMESTAMPTZ;
BEGIN
  IF p_success THEN
    DELETE FROM public.admin_login_throttle WHERE ip = p_ip;
    RETURN NULL;
  END IF;

  INSERT INTO public.admin_login_throttle (ip, fail_count, updated_at)
  VALUES (p_ip, 1, now())
  ON CONFLICT (ip) DO UPDATE
    SET fail_count = public.admin_login_throttle.fail_count + 1,
        updated_at = now()
  RETURNING fail_count INTO v_fail;

  IF v_fail >= 5 THEN
    v_locked := now() + INTERVAL '15 minutes';
    UPDATE public.admin_login_throttle
    SET locked_until = v_locked, updated_at = now()
    WHERE ip = p_ip;
  END IF;

  RETURN v_locked;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_login_locked(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_login_record(TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_login_locked(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_login_record(TEXT, BOOLEAN) TO service_role;