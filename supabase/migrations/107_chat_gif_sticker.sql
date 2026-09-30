-- 107_chat_gif_sticker.sql
-- Adds 'gif' and 'sticker' to chat_messages.kind (spec: social-realtime, GIF/sticker follow-up).
--
-- Same shape as 'payment': body is NULL and the payload (a URL, or an asset id for a bundled
-- sticker) lives in metadata, so a bubble and any future reuse of that image cannot disagree.
--
-- Apply after 106, in filename order.

ALTER TABLE public.chat_messages DROP CONSTRAINT IF EXISTS chat_messages_kind_check;
ALTER TABLE public.chat_messages ADD CONSTRAINT chat_messages_kind_check
  CHECK (kind IN ('text', 'payment', 'system', 'gif', 'sticker'));

ALTER TABLE public.chat_messages DROP CONSTRAINT IF EXISTS chat_messages_text_has_body;
ALTER TABLE public.chat_messages ADD CONSTRAINT chat_messages_text_has_body
  CHECK (kind <> 'text' OR body IS NOT NULL);

-- Mirrors chat_messages_text_has_body: a gif/sticker row carries its content in metadata, so a body
-- here would be a second, possibly disagreeing, copy of nothing in particular.
ALTER TABLE public.chat_messages DROP CONSTRAINT IF EXISTS chat_messages_media_has_no_body;
ALTER TABLE public.chat_messages ADD CONSTRAINT chat_messages_media_has_no_body
  CHECK (kind NOT IN ('gif', 'sticker') OR body IS NULL);
