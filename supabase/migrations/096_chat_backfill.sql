-- 096_chat_backfill.sql
-- Moves `circle_messages` onto 094's tables and derives payment messages for existing transfers
-- (spec: social-realtime tasks 4).
--
-- Apply after 095, in filename order. Idempotent: every insert is keyed on a derived `client_id`, so
-- re-running adds nothing.
--
-- ── why the payment backfill exists ──────────────────────────────────────────
-- The person page is the thread, and the thread is one sequence-ordered query. Without backfilled
-- payment messages a relationship would show only what happened after chat shipped, and the screen
-- would need a second cursor over `p2p_transfers` — which weakens the single-sequence resync the whole
-- design leans on. These rows are derived from an authoritative table, so this is re-runnable and
-- `p2p_transfers` stays the source of truth.
--
-- ── why not chat_post_message ────────────────────────────────────────────────
-- It allocates one sequence per call and increments every other member's unread counter. Backfilling
-- through it would hand every user a wall of unread badges for history they have already seen. These
-- insert directly and then set `read_seq = last_seq` with `unread_count = 0`, so old conversations
-- arrive read.
--
-- `circle_messages` is deliberately LEFT IN PLACE. Dropping it in the same migration that moves its
-- data means a rollback loses messages; it goes in a later migration once the route has been serving
-- from `chat_messages` in production for a while.

-- ── direction is NOT stored ──────────────────────────────────────────────────
-- A transfer is outgoing for the sender and incoming for the recipient, so "direction" is a property
-- of who is looking, not of the row. The message carries the transfer's sender in `sender_id` and the
-- client derives direction by comparing it to the viewer, exactly as the activity feed already does.
-- Storing it would be wrong for one of the two people in every thread.

-- ── 1. a room per circle that has messages ───────────────────────────────────
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT DISTINCT group_id FROM public.circle_messages
  LOOP
    PERFORM public.chat_room_for_circle(r.group_id);
  END LOOP;
END $$;

-- ── 2. copy circle messages, sequenced by their original order ───────────────
INSERT INTO public.chat_messages (room_id, seq, sender_id, client_id, kind, body, created_at)
SELECT
  rm.id,
  row_number() OVER (PARTITION BY cm.group_id ORDER BY cm.created_at, cm.id),
  cm.user_id,
  'legacy:' || cm.id,
  'text',
  cm.body,
  cm.created_at
FROM public.circle_messages cm
JOIN public.chat_rooms rm ON rm.circle_id = cm.group_id
ON CONFLICT (client_id) DO NOTHING;

-- ── 3. a direct room per pair that has a settled transfer ────────────────────
-- Both directions collapse to one pair, so DISTINCT on the sorted ids. chat_room_for_pair's
-- eligibility check is satisfied by construction here: these pairs are settled transfers.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT DISTINCT
      LEAST(sender_id, recipient_id)    AS a,
      GREATEST(sender_id, recipient_id) AS b
    FROM public.p2p_transfers
    WHERE recipient_id IS NOT NULL
      AND sender_id <> recipient_id
      AND status IN ('completed', 'claimed')
  LOOP
    PERFORM public.chat_room_for_pair(r.a, r.b);
  END LOOP;
END $$;

-- ── 4. a payment message per settled transfer ────────────────────────────────
-- `amount_micro` is copied, never a formatted label, so a bubble and the same transfer in the feed
-- cannot disagree by a kobo. The note is the sender's own words and belongs with it.
INSERT INTO public.chat_messages (room_id, seq, sender_id, client_id, kind, body, metadata, created_at)
SELECT
  rm.id,
  row_number() OVER (PARTITION BY rm.id ORDER BY t.created_at, t.id),
  t.sender_id,
  'payment:' || t.id,
  'payment',
  NULL,
  jsonb_build_object(
    'transferId',  t.id,
    'amountMicro', t.amount_micro,
    'note',        t.note,
    'status',      t.status
  ),
  t.created_at
FROM public.p2p_transfers t
JOIN public.chat_rooms rm
  ON rm.pair_key = LEAST(t.sender_id, t.recipient_id)::text || ':' ||
                   GREATEST(t.sender_id, t.recipient_id)::text
WHERE t.recipient_id IS NOT NULL
  AND t.sender_id <> t.recipient_id
  AND t.status IN ('completed', 'claimed')
ON CONFLICT (client_id) DO NOTHING;

-- ── 5. bring each room's high-water mark up to what it now holds ─────────────
UPDATE public.chat_rooms r
   SET last_seq = c.max_seq,
       last_message_at = c.max_at
  FROM (
    SELECT room_id, max(seq) AS max_seq, max(created_at) AS max_at
    FROM public.chat_messages
    GROUP BY room_id
  ) c
 WHERE c.room_id = r.id
   AND r.last_seq < c.max_seq;

-- ── 6. history arrives read, not as a wall of unread badges ──────────────────
-- Only for members whose cursor is still at zero, so re-running this cannot mark genuinely unread
-- messages as read for someone who has since fallen behind.
UPDATE public.chat_room_members m
   SET read_seq = r.last_seq,
       unread_count = 0
  FROM public.chat_rooms r
 WHERE r.id = m.room_id
   AND m.read_seq = 0;
