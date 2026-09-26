-- 097_realtime_tickets.sql
-- Single-use, short-lived tickets for the realtime upgrade (spec: web-intro-and-social-realtime).
--
-- Apply after 096, in filename order.
--
-- ── why a ticket at all ──────────────────────────────────────────────────────
-- A WebSocket upgrade is a GET, and a browser cannot set headers on one. The obvious move is
-- `?token=<jwt>`, and it is wrong: query strings land in access logs, proxy logs and referrers, so
-- the access token would be written to disk in several places on every connect. A ticket is
-- exchanged for the token over an ordinary authenticated POST, lives for thirty seconds, and is
-- consumed on first use, so the worst a leaked URL yields is a ticket that has already been spent.
--
-- ── why Postgres and not memory ──────────────────────────────────────────────
-- A ticket issued by one instance must be redeemable by another the moment there are two, and a
-- process restart between issue and upgrade must not strand a client mid-handshake. Memory fails
-- both. This is also the one piece of realtime state that must outlive a process, which is why it
-- is the only table Phase 3 adds.
--
-- The token itself is generated in Node with `crypto.randomBytes`, not here: randomness belongs
-- where it can be audited, and `gen_random_uuid()` is not a secret-grade generator.

CREATE TABLE IF NOT EXISTS public.realtime_tickets (
  -- The secret. Primary key because a duplicate is a collision, not a row to keep.
  token      TEXT PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  -- Set on redemption. Single use is enforced by an atomic UPDATE, not by reading this first.
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Sweeping expired rows, and a cheap cap on how many a single account can accumulate.
CREATE INDEX IF NOT EXISTS idx_realtime_tickets_expiry ON public.realtime_tickets (expires_at);
CREATE INDEX IF NOT EXISTS idx_realtime_tickets_user   ON public.realtime_tickets (user_id, created_at DESC);

-- RLS on, and no policy at all. A ticket is a bearer secret: its owner has no reason to read it back
-- and nobody else may. Only the service role touches this table, through the two functions below.
ALTER TABLE public.realtime_tickets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.realtime_tickets FROM anon, authenticated;

-- ── issue ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.realtime_ticket_issue(
  p_user  UUID,
  p_token TEXT,
  p_ttl_seconds INT DEFAULT 30
)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_expires TIMESTAMPTZ;
BEGIN
  IF p_token IS NULL OR length(p_token) < 32 THEN
    RAISE EXCEPTION 'ticket must be at least 32 characters' USING ERRCODE = 'check_violation';
  END IF;

  -- Opportunistic sweep, so the table cannot grow without bound from a client that asks for
  -- tickets and never connects. Cheap: it is an index scan on expires_at, and a minute of slack
  -- keeps it clear of a ticket that is mid-handshake.
  DELETE FROM public.realtime_tickets
   WHERE expires_at < now() - INTERVAL '1 minute';

  v_expires := now() + make_interval(secs => GREATEST(p_ttl_seconds, 1));

  INSERT INTO public.realtime_tickets (token, user_id, expires_at)
  VALUES (p_token, p_user, v_expires);

  RETURN v_expires;
END;
$$;

-- ── consume ──────────────────────────────────────────────────────────────────
-- Returns the owner, or NULL when the ticket is unknown, expired or already spent. The caller
-- cannot tell those apart, deliberately: distinguishing them tells an attacker whether a guessed
-- token ever existed.
--
-- Single use is the UPDATE's WHERE clause, not a read followed by a write. Two simultaneous
-- upgrades with the same ticket therefore resolve to exactly one winner, because only one
-- statement can match `used_at IS NULL`.
CREATE OR REPLACE FUNCTION public.realtime_ticket_consume(p_token TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user UUID;
BEGIN
  UPDATE public.realtime_tickets
     SET used_at = now()
   WHERE token = p_token
     AND used_at IS NULL
     AND expires_at > now()
  RETURNING user_id INTO v_user;

  RETURN v_user;
END;
$$;

-- ── grants ───────────────────────────────────────────────────────────────────
-- service_role only. Both functions take a user id or hand one back, and neither consults
-- auth.uid(), so a session must not be able to reach them: issuing a ticket for somebody else's
-- account would be a complete authentication bypass.
REVOKE ALL ON FUNCTION public.realtime_ticket_issue(UUID, TEXT, INT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.realtime_ticket_consume(TEXT)          FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.realtime_ticket_issue(UUID, TEXT, INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.realtime_ticket_consume(TEXT)          TO service_role;
