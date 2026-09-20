-- 092_push_devices.sql
-- Native push device registry, for the Flutter app (spec: mobile-api-foundation task 2).
--
-- Web Push already exists and keeps its own table (`push_subscriptions`), which stores a VAPID
-- endpoint. That shape is useless to a handset: FCM addresses a device by an opaque token, and one
-- user has several. So this is a sibling table rather than a change to that one, and
-- `/api/push/subscribe` is deliberately left alone because the web app is live.
--
-- Apply by hand, in filename order, like every migration here. Nothing in this project applies DDL
-- at boot. Ordering dependency: `auth.users` only, so this can go in any time after 001.
--
-- No money moves here, but the same posture as 083/085/086 applies anyway: RLS on, writes only
-- through SECURITY DEFINER functions granted to service_role, and the client never writes the
-- table. A device token is a capability to reach someone's phone, so it is treated like one.

-- ── the registry ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.push_devices (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token       TEXT NOT NULL,
  platform    TEXT NOT NULL CHECK (platform IN ('android', 'ios')),
  app_version TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Set only on a PERMANENT provider rejection (FCM UNREGISTERED / INVALID_ARGUMENT).
  -- Never on a transient failure, or a flaky network would quietly stop a user's notifications.
  dead_at     TIMESTAMPTZ
);

-- Token is unique GLOBALLY, not per user. A handset that changes account must not leave the
-- previous owner able to push to it, so re-registration reassigns the row rather than adding a
-- second one. This is what makes the upsert in push_device_register correct.
CREATE UNIQUE INDEX IF NOT EXISTS push_devices_token_uniq ON public.push_devices (token);

-- The send path's only query: live devices for one user.
CREATE INDEX IF NOT EXISTS push_devices_live
  ON public.push_devices (user_id) WHERE dead_at IS NULL;

ALTER TABLE public.push_devices ENABLE ROW LEVEL SECURITY;

-- Read-only to the owner, so a user can see their own devices in settings. There is deliberately
-- no client INSERT/UPDATE/DELETE policy: registration goes through the server route.
DROP POLICY IF EXISTS push_devices_owner_read ON public.push_devices;
CREATE POLICY push_devices_owner_read ON public.push_devices
  FOR SELECT USING (auth.uid() = user_id);

-- ── register or refresh ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.push_device_register(
  p_user        UUID,
  p_token       TEXT,
  p_platform    TEXT,
  p_app_version TEXT DEFAULT NULL
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_id BIGINT;
BEGIN
  -- Same guard as p2p_send_direct: a null auth.uid() is the service role calling, anything else
  -- must be acting as itself. Kept even though only service_role holds EXECUTE, so the function is
  -- still safe if that grant is ever widened.
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user THEN
    RAISE EXCEPTION 'push_device_register: unauthorized';
  END IF;
  IF p_token IS NULL OR length(trim(p_token)) = 0 THEN
    RAISE EXCEPTION 'push_device_register: token is required';
  END IF;

  -- Idempotent, and doubles as the reassignment path: same token seen again just moves it to the
  -- current user and revives it if a previous send had marked it dead.
  INSERT INTO public.push_devices (user_id, token, platform, app_version)
  VALUES (p_user, trim(p_token), p_platform, p_app_version)
  ON CONFLICT (token) DO UPDATE
    SET user_id     = EXCLUDED.user_id,
        platform    = EXCLUDED.platform,
        app_version = EXCLUDED.app_version,
        last_seen   = now(),
        dead_at     = NULL
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.push_device_register(UUID,TEXT,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.push_device_register(UUID,TEXT,TEXT,TEXT) TO service_role;

-- ── forget, on sign-out ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.push_device_forget(
  p_user  UUID,
  p_token TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_deleted INT;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user THEN
    RAISE EXCEPTION 'push_device_forget: unauthorized';
  END IF;

  -- Scoped to the caller's own rows: knowing a token must not let you unregister someone else's
  -- handset. Deleted rather than marked dead, because on sign-out the device genuinely stops
  -- belonging to this user; dead_at is for tokens the provider has rejected.
  DELETE FROM public.push_devices
  WHERE user_id = p_user AND token = trim(p_token);

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  -- Idempotent: forgetting an unknown token is a no-op, not an error, so a retried sign-out is fine.
  RETURN v_deleted > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.push_device_forget(UUID,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.push_device_forget(UUID,TEXT) TO service_role;

-- ── mark dead, from the send path ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.push_device_mark_dead(p_token TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_updated INT;
BEGIN
  -- No user scoping and no auth.uid() guard: the caller is the push sender, which knows a token the
  -- provider rejected but has no user context to assert. Reachable only by service_role.
  UPDATE public.push_devices
  SET dead_at = now()
  WHERE token = trim(p_token) AND dead_at IS NULL;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.push_device_mark_dead(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.push_device_mark_dead(TEXT) TO service_role;

-- Table grants: the read policy above covers `authenticated`; no client write path exists.
REVOKE ALL ON TABLE public.push_devices FROM anon;
GRANT SELECT ON TABLE public.push_devices TO authenticated;
