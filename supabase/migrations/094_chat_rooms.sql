-- 094_chat_rooms.sql
-- Rooms, membership and messages (spec: social-realtime, PAWA_2.0_REDESIGN §09).
--
-- Tables only. The RPCs that write them are 095, and 096 migrates `circle_messages` plus backfills
-- payment messages for existing transfers. Apply in filename order.
--
-- ── the shape, and why ───────────────────────────────────────────────────────
--
-- A message must never be lost and the live path is allowed to fail. Persistence and ordering live
-- here; the WebSocket only says "a row exists". So delivery is the query "everything after seq N",
-- not the socket. Reference implementation `~/zendfi/zendapp` lost messages permanently on a missed
-- frame because nothing ever re-fetched; see docs/REALTIME_DESIGN.md in the app repo.
--
-- `seq` is a per-room counter allocated under the room's row lock, NOT a timestamp. Ordering by a
-- clock needs a tiebreak and invites skew between instances; a counter also makes resync an index
-- seek on (room_id, seq).
--
-- `pair_key` is how a 1:1 room is found without a lookup table: the two ids sorted and joined, so
-- the same pair always computes the same key. That makes room creation idempotent under a race —
-- without it, two people opening a thread simultaneously get two rooms and each sees half the
-- conversation.
--
-- `client_id` is unique GLOBALLY, not per room. Payment rows key on 'payment:' || transfer_id and a
-- transfer belongs to exactly one room, so global is both sufficient and stricter: it makes a
-- mis-routed duplicate impossible rather than merely unlikely.
--
-- No client INSERT or UPDATE anywhere below. Every write goes through 095's SECURITY DEFINER RPCs,
-- matching the posture the money tables already take (083). Clients read; the server writes.

-- ── rooms ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.chat_rooms (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            TEXT NOT NULL CHECK (kind IN ('direct', 'circle')),
  -- Exactly one of these is set, enforced below.
  circle_id       UUID REFERENCES public.esusu_groups(id) ON DELETE CASCADE,
  pair_key        TEXT,
  -- The high-water mark 095 hands out from, and what a client resyncs against.
  last_seq        BIGINT NOT NULL DEFAULT 0,
  last_message_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chat_rooms_shape CHECK (
    (kind = 'direct' AND pair_key IS NOT NULL AND circle_id IS NULL) OR
    (kind = 'circle' AND circle_id IS NOT NULL AND pair_key IS NULL)
  ),

  -- Plain constraints, NOT partial indexes. `ON CONFLICT (pair_key)` cannot infer a partial index,
  -- so `WHERE pair_key IS NOT NULL` would make 095's idempotent upsert fail outright with "no unique
  -- or exclusion constraint matching the ON CONFLICT specification". Plain is also sufficient:
  -- Postgres treats NULLs as distinct in a unique constraint, so every circle row can share a NULL
  -- pair_key while non-null values stay unique.
  CONSTRAINT chat_rooms_pair_key_unique  UNIQUE (pair_key),
  CONSTRAINT chat_rooms_circle_id_unique UNIQUE (circle_id)
);

-- ── membership, and the server-authoritative unread counter ──────────────────
-- The counter lives here rather than being computed by the client because a client-side count drifts
-- the moment a push notification or a second device exists. 095 increments it in the SAME statement
-- that bumps last_message_at, so there is no window where a notification describes a message the
-- counter does not know about.
CREATE TABLE IF NOT EXISTS public.chat_room_members (
  room_id      UUID NOT NULL REFERENCES public.chat_rooms(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES public.profiles(id)   ON DELETE CASCADE,
  unread_count INT    NOT NULL DEFAULT 0 CHECK (unread_count >= 0),
  read_seq     BIGINT NOT NULL DEFAULT 0,
  joined_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);

-- Drives the thread list: a user's rooms, most recent first.
CREATE INDEX IF NOT EXISTS idx_chat_room_members_user ON public.chat_room_members (user_id);

-- ── messages ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.chat_messages (
  id         BIGSERIAL PRIMARY KEY,
  room_id    UUID   NOT NULL REFERENCES public.chat_rooms(id) ON DELETE CASCADE,
  seq        BIGINT NOT NULL,
  -- Null for a system row, which has no author.
  sender_id  UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- Client-generated for text, derived for payments ('payment:' || transfer_id) and for the 096
  -- backfill ('legacy:' || old_id). The unique index below is the whole idempotency story.
  client_id  TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('text', 'payment', 'system')),
  -- Null for a payment row: its amount, direction and note live in metadata and are re-derived for
  -- display, so a bubble and the activity feed cannot disagree by a kobo.
  body       TEXT CHECK (body IS NULL OR char_length(body) BETWEEN 1 AND 1000),
  metadata   JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chat_messages_text_has_body CHECK (kind <> 'text' OR body IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_messages_seq       ON public.chat_messages (room_id, seq);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_messages_client_id ON public.chat_messages (client_id);

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Read scoped to membership. No INSERT or UPDATE policy on any of the three, deliberately: with RLS
-- enabled and no permissive policy for a command, that command is denied. 095's definer functions
-- are the only writers.
ALTER TABLE public.chat_rooms        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_room_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages     ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS chat_rooms_member_read ON public.chat_rooms;
CREATE POLICY chat_rooms_member_read ON public.chat_rooms FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM public.chat_room_members m
    WHERE m.room_id = chat_rooms.id AND m.user_id = auth.uid()
  )
);

-- A member sees who else is in the room, and their own counter. Not other members' counters: an
-- unread count reveals whether someone has read you, which is a read receipt by the back door and
-- this spec deliberately does not ship those.
DROP POLICY IF EXISTS chat_room_members_self_read ON public.chat_room_members;
CREATE POLICY chat_room_members_self_read ON public.chat_room_members FOR SELECT USING (
  user_id = auth.uid()
);

DROP POLICY IF EXISTS chat_messages_member_read ON public.chat_messages;
CREATE POLICY chat_messages_member_read ON public.chat_messages FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM public.chat_room_members m
    WHERE m.room_id = chat_messages.room_id AND m.user_id = auth.uid()
  )
);

-- ── grants ───────────────────────────────────────────────────────────────────
-- SELECT only, and only for a signed-in user. RLS narrows it to membership from there.
GRANT SELECT ON public.chat_rooms        TO authenticated;
GRANT SELECT ON public.chat_room_members TO authenticated;
GRANT SELECT ON public.chat_messages     TO authenticated;

REVOKE ALL ON public.chat_rooms        FROM anon;
REVOKE ALL ON public.chat_room_members FROM anon;
REVOKE ALL ON public.chat_messages     FROM anon;
