-- 108_p2p_attachment.sql
-- Lets a P2P transfer carry a GIF or sticker (spec: expressive payments, follow-up to 107).
--
-- Same shape as chat's media messages: a kind plus a url, nullable together. A payment with no
-- attachment (every payment today) leaves both null; nothing downstream has to special-case that,
-- it is just the default a column addition gives you for free.
--
-- Apply after 107, in filename order.

ALTER TABLE public.p2p_transfers ADD COLUMN IF NOT EXISTS attachment_kind TEXT;
ALTER TABLE public.p2p_transfers ADD COLUMN IF NOT EXISTS attachment_url  TEXT;

ALTER TABLE public.p2p_transfers DROP CONSTRAINT IF EXISTS p2p_transfers_attachment_shape;
ALTER TABLE public.p2p_transfers ADD CONSTRAINT p2p_transfers_attachment_shape CHECK (
  (attachment_kind IS NULL AND attachment_url IS NULL) OR
  (attachment_kind IN ('gif', 'sticker') AND attachment_url IS NOT NULL)
);

-- ── p2p_send_direct: add the two optional params, store them ─────────────────
-- Signatures are part of a Postgres function's identity, so the old five-argument overload has to
-- go before the new seven-argument one can take its name. New params are DEFAULT NULL, so a caller
-- that has not been updated yet — there should be none, but the route and the RPC do not deploy
-- atomically — keeps sending payments with no attachment rather than failing outright.
DROP FUNCTION IF EXISTS public.p2p_send_direct(UUID,UUID,BIGINT,TEXT,TEXT);

CREATE OR REPLACE FUNCTION public.p2p_send_direct(
  p_sender          UUID,
  p_recipient       UUID,
  p_amount_micro    BIGINT,
  p_reference       TEXT,
  p_note            TEXT DEFAULT NULL,
  p_attachment_kind TEXT DEFAULT NULL,
  p_attachment_url  TEXT DEFAULT NULL
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  w        public.wallets%rowtype;
  v_id     BIGINT;
  v_kobo   BIGINT := p_amount_micro / 10000;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_sender THEN
    RAISE EXCEPTION 'p2p_send_direct: unauthorized';
  END IF;
  IF p_sender = p_recipient THEN RAISE EXCEPTION 'p2p_send_direct: cannot send to self'; END IF;
  IF p_amount_micro <= 0 THEN RAISE EXCEPTION 'p2p_send_direct: amount must be positive'; END IF;
  IF p_attachment_kind IS NOT NULL AND p_attachment_kind NOT IN ('gif', 'sticker') THEN
    RAISE EXCEPTION 'p2p_send_direct: bad attachment kind';
  END IF;

  -- Debit the sender under a row lock; refuse if short.
  SELECT * INTO w FROM public.wallets WHERE user_id = p_sender FOR UPDATE;
  IF NOT FOUND OR w.usdc_balance_micro < p_amount_micro THEN
    RAISE EXCEPTION 'p2p_send_direct: insufficient balance';
  END IF;
  UPDATE public.wallets
    SET usdc_balance_micro = usdc_balance_micro - p_amount_micro, updated_at = now()
    WHERE user_id = p_sender;
  UPDATE public.wallets
    SET usdc_balance_micro = usdc_balance_micro + p_amount_micro, updated_at = now()
    WHERE user_id = p_recipient;

  INSERT INTO public.p2p_transfers
    (sender_id, recipient_id, amount_micro, note, kind, status, reference,
     attachment_kind, attachment_url)
  VALUES (p_sender, p_recipient, p_amount_micro, p_note, 'direct', 'completed', p_reference,
          p_attachment_kind, p_attachment_url)
  RETURNING id INTO v_id;

  INSERT INTO public.transactions
    (user_id, type, direction, amount_kobo, amount_usdc_micro, description, reference, status, metadata)
  VALUES
    (p_sender, 'transfer_out', 'debit', v_kobo, p_amount_micro,
     'Sent to a PawaSave friend', p_reference || ':out', 'completed',
     jsonb_build_object('p2p_id', v_id, 'kind', 'direct', 'counterparty', p_recipient)),
    (p_recipient, 'transfer_in', 'credit', v_kobo, p_amount_micro,
     'Received from a PawaSave friend', p_reference || ':in', 'completed',
     jsonb_build_object('p2p_id', v_id, 'kind', 'direct', 'counterparty', p_sender));

  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.p2p_send_direct(UUID,UUID,BIGINT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.p2p_send_direct(UUID,UUID,BIGINT,TEXT,TEXT,TEXT,TEXT) TO service_role;

-- ── p2p_send_claim: same two params, same storage ─────────────────────────────
DROP FUNCTION IF EXISTS public.p2p_send_claim(UUID,TEXT,BIGINT,TEXT,TIMESTAMPTZ,TEXT);

CREATE OR REPLACE FUNCTION public.p2p_send_claim(
  p_sender          UUID,
  p_recipient_email TEXT,
  p_amount_micro    BIGINT,
  p_reference       TEXT,
  p_expires_at      TIMESTAMPTZ,
  p_note            TEXT DEFAULT NULL,
  p_attachment_kind TEXT DEFAULT NULL,
  p_attachment_url  TEXT DEFAULT NULL
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  w      public.wallets%rowtype;
  v_id   BIGINT;
  v_kobo BIGINT := p_amount_micro / 10000;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_sender THEN
    RAISE EXCEPTION 'p2p_send_claim: unauthorized';
  END IF;
  IF p_amount_micro <= 0 THEN RAISE EXCEPTION 'p2p_send_claim: amount must be positive'; END IF;
  IF p_attachment_kind IS NOT NULL AND p_attachment_kind NOT IN ('gif', 'sticker') THEN
    RAISE EXCEPTION 'p2p_send_claim: bad attachment kind';
  END IF;

  SELECT * INTO w FROM public.wallets WHERE user_id = p_sender FOR UPDATE;
  IF NOT FOUND OR w.usdc_balance_micro < p_amount_micro THEN
    RAISE EXCEPTION 'p2p_send_claim: insufficient balance';
  END IF;
  UPDATE public.wallets
    SET usdc_balance_micro = usdc_balance_micro - p_amount_micro, updated_at = now()
    WHERE user_id = p_sender;

  INSERT INTO public.p2p_transfers
    (sender_id, recipient_email, amount_micro, note, kind, status, reference, expires_at,
     attachment_kind, attachment_url)
  VALUES (p_sender, lower(trim(p_recipient_email)), p_amount_micro, p_note, 'claim', 'pending',
          p_reference, p_expires_at, p_attachment_kind, p_attachment_url)
  RETURNING id INTO v_id;

  -- The money has left the sender's spendable balance; book it now. The offsetting refund (on
  -- revert) or the recipient credit (on claim) is booked when that happens.
  INSERT INTO public.transactions
    (user_id, type, direction, amount_kobo, amount_usdc_micro, description, reference, status, metadata)
  VALUES
    (p_sender, 'transfer_out', 'debit', v_kobo, p_amount_micro,
     format('Sent to %s (awaiting claim)', lower(trim(p_recipient_email))),
     p_reference || ':out', 'completed',
     jsonb_build_object('p2p_id', v_id, 'kind', 'claim', 'recipient_email', lower(trim(p_recipient_email))));

  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.p2p_send_claim(UUID,TEXT,BIGINT,TEXT,TIMESTAMPTZ,TEXT,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.p2p_send_claim(UUID,TEXT,BIGINT,TEXT,TIMESTAMPTZ,TEXT,TEXT,TEXT) TO service_role;
