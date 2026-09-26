-- 095_chat_rpcs.sql
-- The only writers for 094's tables (spec: social-realtime).
--
-- Same posture as 083's money RPCs: SECURITY DEFINER, `search_path` pinned, EXECUTE granted to
-- `service_role` only. The routes call these with the service role after checking the caller's JWT,
-- so a client can never reach them even if a grant is widened by accident later.
--
-- Apply after 094, in filename order.

-- ── who may talk to whom ─────────────────────────────────────────────────────
-- Chat is grounded in the graph: you may message someone you have a COMPLETED transfer with, in
-- either direction. That removes the unsolicited-contact surface entirely rather than needing a
-- moderation tool, because reaching a stranger costs a real transfer. It also matches the product:
-- money is native here, so the money comes first and the conversation follows.
--
-- 'completed' and 'claimed' both count as settled. A 'pending' escrow does not: an unclaimed send to
-- an email address has no account behind it yet, so there is nobody to open a room with.
CREATE OR REPLACE FUNCTION public.chat_may_pair(p_a UUID, p_b UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.p2p_transfers t
    WHERE t.status IN ('completed', 'claimed')
      AND (
        (t.sender_id = p_a AND t.recipient_id = p_b) OR
        (t.sender_id = p_b AND t.recipient_id = p_a)
      )
  );
$$;

-- ── find or create the 1:1 room for a pair ───────────────────────────────────
-- Idempotent by construction. `pair_key` is the sorted ids, so both sides compute the same value and
-- the unique index turns a simultaneous double call into one room. Doing this with a SELECT-then-
-- INSERT would race; ON CONFLICT is what makes it safe.
CREATE OR REPLACE FUNCTION public.chat_room_for_pair(p_self UUID, p_other UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_key     TEXT;
  v_room_id UUID;
BEGIN
  IF p_self IS NULL OR p_other IS NULL THEN
    RAISE EXCEPTION 'both users are required';
  END IF;
  IF p_self = p_other THEN
    RAISE EXCEPTION 'cannot open a room with yourself';
  END IF;
  IF NOT public.chat_may_pair(p_self, p_other) THEN
    RAISE EXCEPTION 'no completed transfer between these users' USING ERRCODE = 'check_violation';
  END IF;

  -- Sorted, so the key does not depend on who asked.
  v_key := CASE WHEN p_self < p_other
                THEN p_self::text || ':' || p_other::text
                ELSE p_other::text || ':' || p_self::text
           END;

  INSERT INTO public.chat_rooms (kind, pair_key)
  VALUES ('direct', v_key)
  ON CONFLICT (pair_key) DO NOTHING
  RETURNING id INTO v_room_id;

  -- ON CONFLICT DO NOTHING returns no row, so read the existing one.
  IF v_room_id IS NULL THEN
    SELECT id INTO v_room_id FROM public.chat_rooms WHERE pair_key = v_key;
  END IF;

  -- Both memberships, also idempotent, so a partially-created room self-heals.
  INSERT INTO public.chat_room_members (room_id, user_id)
  VALUES (v_room_id, p_self), (v_room_id, p_other)
  ON CONFLICT (room_id, user_id) DO NOTHING;

  RETURN v_room_id;
END;
$$;

-- ── find or create a circle's room ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.chat_room_for_circle(p_circle UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_room_id UUID;
BEGIN
  INSERT INTO public.chat_rooms (kind, circle_id)
  VALUES ('circle', p_circle)
  ON CONFLICT (circle_id) DO NOTHING
  RETURNING id INTO v_room_id;

  IF v_room_id IS NULL THEN
    SELECT id INTO v_room_id FROM public.chat_rooms WHERE circle_id = p_circle;
  END IF;

  -- Membership follows the circle. Re-synced on every call rather than by a trigger on
  -- esusu_members, so someone who joined before this migration is not left out of the thread.
  INSERT INTO public.chat_room_members (room_id, user_id)
  SELECT v_room_id, m.user_id FROM public.esusu_members m WHERE m.group_id = p_circle
  ON CONFLICT (room_id, user_id) DO NOTHING;

  RETURN v_room_id;
END;
$$;

-- ── post a message ───────────────────────────────────────────────────────────
-- Returns the stored row either way. On a duplicate `client_id` it returns the ORIGINAL rather than
-- raising, so a retry after a timeout is indistinguishable from a first attempt to the caller. That
-- is what lets the client retry a chat POST freely, unlike p2p/send which has no idempotency key.
--
-- The unread increment is in the same statement as the last_message_at bump. Splitting them leaves a
-- window where a push notification describes a message the counter has not seen.
CREATE OR REPLACE FUNCTION public.chat_post_message(
  p_room      UUID,
  p_sender    UUID,
  p_client_id TEXT,
  p_kind      TEXT,
  p_body      TEXT    DEFAULT NULL,
  p_metadata  JSONB   DEFAULT NULL
)
RETURNS public.chat_messages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_seq BIGINT;
  v_row public.chat_messages;
BEGIN
  IF p_client_id IS NULL OR length(p_client_id) = 0 THEN
    RAISE EXCEPTION 'client_id is required';
  END IF;

  -- Idempotent early exit. Cheaper than relying on the conflict path, and it means the sequence is
  -- not consumed by a retry.
  SELECT * INTO v_row FROM public.chat_messages WHERE client_id = p_client_id;
  IF FOUND THEN
    RETURN v_row;
  END IF;

  -- A system row has no sender; anything else must be a member.
  IF p_sender IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.chat_room_members m
    WHERE m.room_id = p_room AND m.user_id = p_sender
  ) THEN
    RAISE EXCEPTION 'not a member of this room' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- The row lock is what makes seq gap-free under concurrent posts.
  UPDATE public.chat_rooms
     SET last_seq = last_seq + 1,
         last_message_at = now()
   WHERE id = p_room
  RETURNING last_seq INTO v_seq;

  IF v_seq IS NULL THEN
    RAISE EXCEPTION 'no such room';
  END IF;

  BEGIN
    INSERT INTO public.chat_messages (room_id, seq, sender_id, client_id, kind, body, metadata)
    VALUES (p_room, v_seq, p_sender, p_client_id, p_kind, p_body, p_metadata)
    RETURNING * INTO v_row;
  EXCEPTION WHEN unique_violation THEN
    -- Lost a race on client_id between the check above and here. Return the winner's row; the seq
    -- allocated by this call is simply skipped, which the client never sees because it reads by
    -- "after N" rather than assuming every value exists.
    SELECT * INTO v_row FROM public.chat_messages WHERE client_id = p_client_id;
    RETURN v_row;
  END;

  -- Everyone but the author.
  UPDATE public.chat_room_members
     SET unread_count = unread_count + 1
   WHERE room_id = p_room
     AND (p_sender IS NULL OR user_id <> p_sender);

  RETURN v_row;
END;
$$;

-- ── advance a read cursor ────────────────────────────────────────────────────
-- Monotonic: GREATEST means a stale client cannot walk the cursor backwards and resurrect an unread
-- badge. The count is recomputed from the cursor rather than decremented, so it cannot drift.
CREATE OR REPLACE FUNCTION public.chat_mark_read(p_room UUID, p_user UUID, p_seq BIGINT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.chat_room_members m
     SET read_seq = GREATEST(m.read_seq, p_seq),
         unread_count = (
           SELECT count(*) FROM public.chat_messages c
           WHERE c.room_id = p_room
             AND c.seq > GREATEST(m.read_seq, p_seq)
             AND (c.sender_id IS NULL OR c.sender_id <> p_user)
         )
   WHERE m.room_id = p_room AND m.user_id = p_user;
END;
$$;

-- ── grants ───────────────────────────────────────────────────────────────────
-- service_role only. The routes verify the JWT and pass the user id; nothing here trusts auth.uid(),
-- so these must not be reachable from a session.
REVOKE ALL ON FUNCTION public.chat_may_pair(UUID, UUID)                                    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chat_room_for_pair(UUID, UUID)                               FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chat_room_for_circle(UUID)                                   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chat_post_message(UUID, UUID, TEXT, TEXT, TEXT, JSONB)       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chat_mark_read(UUID, UUID, BIGINT)                           FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.chat_may_pair(UUID, UUID)                                 TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_room_for_pair(UUID, UUID)                            TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_room_for_circle(UUID)                                TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_post_message(UUID, UUID, TEXT, TEXT, TEXT, JSONB)    TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_mark_read(UUID, UUID, BIGINT)                        TO service_role;
