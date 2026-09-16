-- 083_p2p_transfers.sql
-- Peer-to-peer cNGN transfers — the "send money to a person" rail.
--
-- Two shapes, one send box:
--   • DIRECT — the recipient already has a PawaSave account (resolved by email). The move is a
--     pure internal ledger transfer: debit sender, credit recipient, instant and FREE. No custody
--     signing, no on-chain, no gas — it's the same cNGN pool backing every balance.
--   • CLAIM  — the recipient has no account yet. The amount is debited from the sender and HELD in
--     the p2p_transfers row (an escrow the platform owes to either party). The recipient gets an
--     email; when they sign up / log in with THAT email and their address is verified, they claim
--     it. If unclaimed by expires_at, a cron reverts it to the sender.
--
-- Money safety: every state transition is done under FOR UPDATE with a status guard, so a retry,
-- double-claim, or claim/revert race can never double-spend or double-credit. cNGN lives in
-- wallets.usdc_balance_micro (6dp, pegged 1:1 to naira). Amounts are stored non-negative
-- (see 081) with direction carrying the sign; ledger rows carry both amount_kobo (micro/10000,
-- for the naira feed) and amount_usdc_micro (the authoritative cNGN figure).

-- ── ledger vocabulary ────────────────────────────────────────────────────────
ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
ALTER TABLE public.transactions ADD CONSTRAINT transactions_type_check CHECK (type IN (
  'deposit', 'withdrawal', 'save_to_vault', 'vault_withdraw',
  'esusu_contribute', 'esusu_payout', 'emergency_payout',
  'split_auto_save', 'split_auto_esusu',
  'goal_contribute', 'goal_claim',
  'creator_incentive', 'cngn_pool_in',
  'loan_disbursement', 'loan_repayment', 'loan_liquidation',
  'equity_buy', 'equity_sell', 'investment',
  'transfer_in', 'transfer_out'
));

-- ── transfers table + lifecycle ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.p2p_transfers (
  id               BIGSERIAL PRIMARY KEY,
  sender_id        UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  recipient_id     UUID REFERENCES public.profiles(id) ON DELETE SET NULL, -- set on direct + on claim
  recipient_email  TEXT,                       -- lower-cased; the claim target when no account yet
  amount_micro     BIGINT NOT NULL CHECK (amount_micro > 0),   -- cNGN, 6dp
  fee_micro        BIGINT NOT NULL DEFAULT 0 CHECK (fee_micro >= 0), -- free today; column keeps options open
  note             TEXT,                       -- optional message from the sender
  kind             TEXT NOT NULL CHECK (kind IN ('direct', 'claim')),
  status           TEXT NOT NULL
                   CHECK (status IN ('completed', 'pending', 'claimed', 'reverted', 'cancelled')),
  reference        TEXT NOT NULL UNIQUE,       -- stable id used on both ledger legs
  expires_at       TIMESTAMPTZ,                -- claim only
  claimed_at       TIMESTAMPTZ,
  reverted_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_p2p_sender    ON public.p2p_transfers (sender_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_p2p_recipient ON public.p2p_transfers (recipient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_p2p_claimable ON public.p2p_transfers (lower(recipient_email)) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_p2p_expiry    ON public.p2p_transfers (expires_at) WHERE status = 'pending';

ALTER TABLE public.p2p_transfers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p2p_party_read ON public.p2p_transfers;
CREATE POLICY p2p_party_read ON public.p2p_transfers FOR SELECT
  USING (auth.uid() = sender_id OR auth.uid() = recipient_id);
-- Incoming claims (recipient has no account row yet) are surfaced server-side via the service
-- role after verifying the caller's authenticated email — never exposed by RLS on an email guess.

-- ── resolve an email to a user id (service role only) ─────────────────────────
-- Reads auth.users, which is why this must be SECURITY DEFINER owned by the migration role.
-- Used by the send route to decide DIRECT vs CLAIM. Never exposed to clients.
CREATE OR REPLACE FUNCTION public.find_user_by_email(p_email TEXT)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v_id UUID;
BEGIN
  SELECT id INTO v_id FROM auth.users WHERE lower(email) = lower(trim(p_email)) LIMIT 1;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.find_user_by_email(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.find_user_by_email(TEXT) TO service_role;

-- ── DIRECT: instant internal transfer between two accounts ────────────────────
CREATE OR REPLACE FUNCTION public.p2p_send_direct(
  p_sender       UUID,
  p_recipient    UUID,
  p_amount_micro BIGINT,
  p_reference    TEXT,
  p_note         TEXT DEFAULT NULL
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
    (sender_id, recipient_id, amount_micro, note, kind, status, reference)
  VALUES (p_sender, p_recipient, p_amount_micro, p_note, 'direct', 'completed', p_reference)
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
REVOKE ALL ON FUNCTION public.p2p_send_direct(UUID,UUID,BIGINT,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.p2p_send_direct(UUID,UUID,BIGINT,TEXT,TEXT) TO service_role;

-- ── CLAIM: debit sender, hold in escrow for an emailed recipient ──────────────
CREATE OR REPLACE FUNCTION public.p2p_send_claim(
  p_sender          UUID,
  p_recipient_email TEXT,
  p_amount_micro    BIGINT,
  p_reference       TEXT,
  p_expires_at      TIMESTAMPTZ,
  p_note            TEXT DEFAULT NULL
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

  SELECT * INTO w FROM public.wallets WHERE user_id = p_sender FOR UPDATE;
  IF NOT FOUND OR w.usdc_balance_micro < p_amount_micro THEN
    RAISE EXCEPTION 'p2p_send_claim: insufficient balance';
  END IF;
  UPDATE public.wallets
    SET usdc_balance_micro = usdc_balance_micro - p_amount_micro, updated_at = now()
    WHERE user_id = p_sender;

  INSERT INTO public.p2p_transfers
    (sender_id, recipient_email, amount_micro, note, kind, status, reference, expires_at)
  VALUES (p_sender, lower(trim(p_recipient_email)), p_amount_micro, p_note, 'claim', 'pending',
          p_reference, p_expires_at)
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
REVOKE ALL ON FUNCTION public.p2p_send_claim(UUID,TEXT,BIGINT,TEXT,TIMESTAMPTZ,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.p2p_send_claim(UUID,TEXT,BIGINT,TEXT,TIMESTAMPTZ,TEXT) TO service_role;

-- ── claim a pending transfer (idempotent, email-bound) ────────────────────────
-- The route has already verified the caller's authenticated email == the row's recipient_email;
-- we re-assert it here (defence in depth) and credit exactly once under FOR UPDATE.
CREATE OR REPLACE FUNCTION public.p2p_claim(
  p_transfer_id     BIGINT,
  p_recipient       UUID,
  p_recipient_email TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  t      public.p2p_transfers%rowtype;
  v_kobo BIGINT;
BEGIN
  SELECT * INTO t FROM public.p2p_transfers WHERE id = p_transfer_id FOR UPDATE;
  IF NOT FOUND OR t.status <> 'pending' THEN RETURN FALSE; END IF;      -- already claimed/reverted/unknown
  IF t.expires_at IS NOT NULL AND t.expires_at < now() THEN RETURN FALSE; END IF; -- expired; let revert handle it
  IF lower(trim(p_recipient_email)) <> t.recipient_email THEN
    RAISE EXCEPTION 'p2p_claim: email does not match the recipient';
  END IF;
  IF p_recipient = t.sender_id THEN RAISE EXCEPTION 'p2p_claim: sender cannot claim own transfer'; END IF;

  v_kobo := t.amount_micro / 10000;

  UPDATE public.p2p_transfers
    SET status = 'claimed', recipient_id = p_recipient, claimed_at = now(), updated_at = now()
    WHERE id = t.id;

  UPDATE public.wallets
    SET usdc_balance_micro = usdc_balance_micro + t.amount_micro, updated_at = now()
    WHERE user_id = p_recipient;

  INSERT INTO public.transactions
    (user_id, type, direction, amount_kobo, amount_usdc_micro, description, reference, status, metadata)
  VALUES
    (p_recipient, 'transfer_in', 'credit', v_kobo, t.amount_micro,
     'Received from a PawaSave friend', t.reference || ':in', 'completed',
     jsonb_build_object('p2p_id', t.id, 'kind', 'claim', 'counterparty', t.sender_id));
  -- No ON CONFLICT needed: the status flip above runs under FOR UPDATE, so this insert
  -- executes at most once per transfer.

  RETURN TRUE;
END;
$$;
REVOKE ALL ON FUNCTION public.p2p_claim(BIGINT,UUID,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.p2p_claim(BIGINT,UUID,TEXT) TO service_role;

-- ── revert a pending claim back to the sender (expiry or cancel) ──────────────
CREATE OR REPLACE FUNCTION public.p2p_revert(
  p_transfer_id BIGINT,
  p_reason      TEXT  -- 'expired' | 'cancelled'
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  t      public.p2p_transfers%rowtype;
  v_kobo BIGINT;
BEGIN
  IF p_reason NOT IN ('expired', 'cancelled') THEN
    RAISE EXCEPTION 'p2p_revert: bad reason %', p_reason;
  END IF;

  SELECT * INTO t FROM public.p2p_transfers WHERE id = p_transfer_id FOR UPDATE;
  IF NOT FOUND OR t.status <> 'pending' THEN RETURN FALSE; END IF;   -- idempotent

  v_kobo := t.amount_micro / 10000;

  UPDATE public.p2p_transfers
    SET status = (CASE WHEN p_reason = 'cancelled' THEN 'cancelled' ELSE 'reverted' END),
        reverted_at = now(), updated_at = now()
    WHERE id = t.id;

  -- Refund the held amount to the sender.
  UPDATE public.wallets
    SET usdc_balance_micro = usdc_balance_micro + t.amount_micro, updated_at = now()
    WHERE user_id = t.sender_id;

  INSERT INTO public.transactions
    (user_id, type, direction, amount_kobo, amount_usdc_micro, description, reference, status, metadata)
  VALUES
    (t.sender_id, 'transfer_in', 'credit', v_kobo, t.amount_micro,
     CASE WHEN p_reason = 'cancelled' THEN 'Transfer cancelled — refunded'
          ELSE 'Unclaimed transfer returned' END,
     t.reference || ':refund', 'completed',
     jsonb_build_object('p2p_id', t.id, 'kind', 'claim', 'reason', p_reason));
  -- Single-execution guaranteed by the status flip under FOR UPDATE above.

  RETURN TRUE;
END;
$$;
REVOKE ALL ON FUNCTION public.p2p_revert(BIGINT,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.p2p_revert(BIGINT,TEXT) TO service_role;
