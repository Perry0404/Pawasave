-- 086_pay_with_pawa.sql
-- Product plan §3.6 "Pay with Pawa — merchant/commerce layer".
--
-- Every seller uses their existing @tag (084) as their Pawa Tag; a `merchant_enabled` flag turns a
-- normal account into a seller and `merchant_name` is the storefront name. Payments run across three
-- surfaces (checkout | link | qr) with an ESCROW mode that is the actual differentiator:
--   buyer pays into escrow → seller ships → buyer confirms (or auto-release after N days).
-- High-trust sellers can take instant settlement instead (escrow = false).
--
-- This REUSES the same escrow money-safety as the p2p claim-link (083): the buyer's cNGN is debited
-- and HELD on the order row (an escrow the platform owes to one party), then released to the seller
-- or refunded to the buyer — each transition under FOR UPDATE with a status guard, so a
-- retry/double-release/double-refund race can never double-spend. Pure internal ledger
-- (wallets.usdc_balance_micro, 1 NGN = 1 cNGN = 1_000_000 micro); no custody signing, no on-chain.

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
  'transfer_in', 'transfer_out',
  'pawa_pay', 'pawa_receive', 'pawa_refund'
));

-- ── merchant profile ──────────────────────────────────────────────────────────
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS merchant_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS merchant_name    TEXT,
  ADD COLUMN IF NOT EXISTS merchant_bio     TEXT;

-- ── orders / escrow table ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pawa_orders (
  id             BIGSERIAL PRIMARY KEY,
  seller_id      UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  buyer_id       UUID REFERENCES public.profiles(id) ON DELETE SET NULL, -- null until paid (link/qr)
  amount_micro   BIGINT NOT NULL CHECK (amount_micro > 0),
  fee_micro      BIGINT NOT NULL DEFAULT 0 CHECK (fee_micro >= 0),
  note           TEXT,                       -- item / order description from the seller
  surface        TEXT NOT NULL CHECK (surface IN ('checkout','link','qr')),
  escrow         BOOLEAN NOT NULL DEFAULT TRUE,
  status         TEXT NOT NULL
                 CHECK (status IN ('pending','paid','released','refunded','disputed','cancelled')),
  reference      TEXT NOT NULL UNIQUE,       -- stable id, also the /pay link token
  auto_release_at TIMESTAMPTZ,               -- escrow only: when the buyer's silence releases funds
  paid_at        TIMESTAMPTZ,
  released_at    TIMESTAMPTZ,
  refunded_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pawa_seller  ON public.pawa_orders (seller_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pawa_buyer   ON public.pawa_orders (buyer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pawa_release ON public.pawa_orders (auto_release_at) WHERE status = 'paid';

ALTER TABLE public.pawa_orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pawa_party_read ON public.pawa_orders;
CREATE POLICY pawa_party_read ON public.pawa_orders FOR SELECT
  USING (auth.uid() = seller_id OR auth.uid() = buyer_id);
-- An unpaid order opened from a link (buyer_id still null) is surfaced server-side via the service
-- role by its unguessable reference — never exposed by RLS to arbitrary callers.

-- ── create a pending order (a payment link / QR / checkout intent) ─────────────
CREATE OR REPLACE FUNCTION public.pawa_create_order(
  p_seller       UUID,
  p_amount_micro BIGINT,
  p_reference    TEXT,
  p_note         TEXT DEFAULT NULL,
  p_surface      TEXT DEFAULT 'link',
  p_escrow       BOOLEAN DEFAULT TRUE
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_id BIGINT;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_seller THEN
    RAISE EXCEPTION 'pawa_create_order: unauthorized';
  END IF;
  IF p_amount_micro <= 0 THEN RAISE EXCEPTION 'pawa_create_order: amount must be positive'; END IF;

  INSERT INTO public.pawa_orders (seller_id, amount_micro, note, surface, escrow, status, reference)
  VALUES (p_seller, p_amount_micro, p_note, p_surface, p_escrow, 'pending', p_reference)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.pawa_create_order(UUID,BIGINT,TEXT,TEXT,TEXT,BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pawa_create_order(UUID,BIGINT,TEXT,TEXT,TEXT,BOOLEAN) TO service_role;

-- Shared money move for a payment. Debits the buyer under FOR UPDATE; on escrow it HOLDS (funds
-- leave the buyer but are not yet credited to the seller), on instant settlement it credits the
-- seller immediately. Booked with both ledger legs. Called by pawa_pay (existing order) and
-- pawa_pay_direct (create+pay atomically for a @tag pay). Not granted to clients.
CREATE OR REPLACE FUNCTION public._pawa_settle_payment(
  p_order      public.pawa_orders,
  p_buyer      UUID,
  p_auto_release_days INT
) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
  w      public.wallets%rowtype;
  v_kobo BIGINT := p_order.amount_micro / 10000;
  v_sname TEXT;
BEGIN
  IF p_buyer = p_order.seller_id THEN RAISE EXCEPTION 'pawa: cannot pay yourself'; END IF;

  SELECT * INTO w FROM public.wallets WHERE user_id = p_buyer FOR UPDATE;
  IF NOT FOUND OR w.usdc_balance_micro < p_order.amount_micro THEN
    RAISE EXCEPTION 'pawa: insufficient balance';
  END IF;
  UPDATE public.wallets
    SET usdc_balance_micro = usdc_balance_micro - p_order.amount_micro, updated_at = now()
    WHERE user_id = p_buyer;

  SELECT COALESCE(merchant_name, display_name, 'a seller') INTO v_sname
    FROM public.profiles WHERE id = p_order.seller_id;

  -- Buyer's debit leg (always booked now — the money has left them).
  INSERT INTO public.transactions
    (user_id, type, direction, amount_kobo, amount_usdc_micro, description, reference, status, metadata)
  VALUES
    (p_buyer, 'pawa_pay', 'debit', v_kobo, p_order.amount_micro,
     CASE WHEN p_order.escrow THEN format('Paid %s (held in escrow)', v_sname)
          ELSE format('Paid %s', v_sname) END,
     p_order.reference || ':pay', 'completed',
     jsonb_build_object('order_id', p_order.id, 'seller', p_order.seller_id, 'escrow', p_order.escrow));

  IF p_order.escrow THEN
    UPDATE public.pawa_orders
      SET status = 'paid', buyer_id = p_buyer, paid_at = now(), updated_at = now(),
          auto_release_at = now() + make_interval(days => GREATEST(1, COALESCE(p_auto_release_days, 3)))
      WHERE id = p_order.id;
  ELSE
    -- Instant settlement: credit the seller now and mark released.
    UPDATE public.wallets
      SET usdc_balance_micro = usdc_balance_micro + p_order.amount_micro, updated_at = now()
      WHERE user_id = p_order.seller_id;
    UPDATE public.pawa_orders
      SET status = 'released', buyer_id = p_buyer, paid_at = now(), released_at = now(), updated_at = now()
      WHERE id = p_order.id;
    INSERT INTO public.transactions
      (user_id, type, direction, amount_kobo, amount_usdc_micro, description, reference, status, metadata)
    VALUES
      (p_order.seller_id, 'pawa_receive', 'credit', v_kobo, p_order.amount_micro,
       'Payment received', p_order.reference || ':recv', 'completed',
       jsonb_build_object('order_id', p_order.id, 'buyer', p_buyer, 'escrow', FALSE));
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public._pawa_settle_payment(public.pawa_orders,UUID,INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._pawa_settle_payment(public.pawa_orders,UUID,INT) TO service_role;

-- Pay an existing pending order by its reference (the link / QR token). Orders are keyed by a
-- bigint id internally, but the payment link only ever carries the unguessable text reference, so
-- that is what the buyer's client presents.
CREATE OR REPLACE FUNCTION public.pawa_pay_ref(
  p_reference TEXT,
  p_buyer     UUID,
  p_auto_release_days INT DEFAULT 3
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE o public.pawa_orders%rowtype;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_buyer THEN
    RAISE EXCEPTION 'pawa_pay_ref: unauthorized';
  END IF;

  SELECT * INTO o FROM public.pawa_orders WHERE reference = p_reference FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'pawa_pay_ref: order not found'; END IF;
  IF o.status <> 'pending' THEN RETURN FALSE; END IF; -- already paid/cancelled — idempotent no-op

  PERFORM public._pawa_settle_payment(o, p_buyer, p_auto_release_days);
  RETURN TRUE;
END;
$$;
REVOKE ALL ON FUNCTION public.pawa_pay_ref(TEXT,UUID,INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pawa_pay_ref(TEXT,UUID,INT) TO service_role;

-- Create + pay atomically — a direct @tag pay with no pre-created link.
CREATE OR REPLACE FUNCTION public.pawa_pay_direct(
  p_buyer        UUID,
  p_seller       UUID,
  p_amount_micro BIGINT,
  p_reference    TEXT,
  p_note         TEXT DEFAULT NULL,
  p_surface      TEXT DEFAULT 'checkout',
  p_escrow       BOOLEAN DEFAULT TRUE,
  p_auto_release_days INT DEFAULT 3
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  o    public.pawa_orders%rowtype;
  v_id BIGINT;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_buyer THEN
    RAISE EXCEPTION 'pawa_pay_direct: unauthorized';
  END IF;
  IF p_amount_micro <= 0 THEN RAISE EXCEPTION 'pawa_pay_direct: amount must be positive'; END IF;
  IF p_buyer = p_seller THEN RAISE EXCEPTION 'pawa_pay_direct: cannot pay yourself'; END IF;

  INSERT INTO public.pawa_orders (seller_id, buyer_id, amount_micro, note, surface, escrow, status, reference)
  VALUES (p_seller, p_buyer, p_amount_micro, p_note, p_surface, p_escrow, 'pending', p_reference)
  RETURNING id INTO v_id;

  SELECT * INTO o FROM public.pawa_orders WHERE id = v_id FOR UPDATE;
  PERFORM public._pawa_settle_payment(o, p_buyer, p_auto_release_days);
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.pawa_pay_direct(UUID,UUID,BIGINT,TEXT,TEXT,TEXT,BOOLEAN,INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pawa_pay_direct(UUID,UUID,BIGINT,TEXT,TEXT,TEXT,BOOLEAN,INT) TO service_role;

-- ── release escrow to the seller (buyer confirms, or the auto-release cron) ────
CREATE OR REPLACE FUNCTION public.pawa_release(
  p_order_id BIGINT,
  p_actor    UUID  -- the buyer; NULL when the auto-release cron calls it
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  o      public.pawa_orders%rowtype;
  v_kobo BIGINT;
BEGIN
  IF p_actor IS NOT NULL AND auth.uid() IS NOT NULL AND auth.uid() <> p_actor THEN
    RAISE EXCEPTION 'pawa_release: unauthorized';
  END IF;

  SELECT * INTO o FROM public.pawa_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND OR o.status <> 'paid' THEN RETURN FALSE; END IF; -- idempotent
  -- Only the buyer may confirm early; the cron (p_actor NULL) may auto-release after the window.
  IF p_actor IS NOT NULL AND p_actor <> o.buyer_id THEN
    RAISE EXCEPTION 'pawa_release: only the buyer can release this payment';
  END IF;

  v_kobo := o.amount_micro / 10000;

  UPDATE public.pawa_orders
    SET status = 'released', released_at = now(), updated_at = now()
    WHERE id = o.id;

  UPDATE public.wallets
    SET usdc_balance_micro = usdc_balance_micro + o.amount_micro, updated_at = now()
    WHERE user_id = o.seller_id;

  INSERT INTO public.transactions
    (user_id, type, direction, amount_kobo, amount_usdc_micro, description, reference, status, metadata)
  VALUES
    (o.seller_id, 'pawa_receive', 'credit', v_kobo, o.amount_micro,
     'Payment released from escrow', o.reference || ':recv', 'completed',
     jsonb_build_object('order_id', o.id, 'buyer', o.buyer_id, 'auto', p_actor IS NULL));

  RETURN TRUE;
END;
$$;
REVOKE ALL ON FUNCTION public.pawa_release(BIGINT,UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pawa_release(BIGINT,UUID) TO service_role;

-- ── refund escrow to the buyer (seller goodwill / dispute resolution) ──────────
CREATE OR REPLACE FUNCTION public.pawa_refund(
  p_order_id BIGINT,
  p_reason   TEXT DEFAULT 'refunded'
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  o      public.pawa_orders%rowtype;
  v_kobo BIGINT;
BEGIN
  SELECT * INTO o FROM public.pawa_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND OR o.status NOT IN ('paid','disputed') THEN RETURN FALSE; END IF; -- idempotent
  IF o.buyer_id IS NULL THEN RAISE EXCEPTION 'pawa_refund: no buyer to refund'; END IF;

  v_kobo := o.amount_micro / 10000;

  UPDATE public.pawa_orders
    SET status = 'refunded', refunded_at = now(), updated_at = now()
    WHERE id = o.id;

  UPDATE public.wallets
    SET usdc_balance_micro = usdc_balance_micro + o.amount_micro, updated_at = now()
    WHERE user_id = o.buyer_id;

  INSERT INTO public.transactions
    (user_id, type, direction, amount_kobo, amount_usdc_micro, description, reference, status, metadata)
  VALUES
    (o.buyer_id, 'pawa_refund', 'credit', v_kobo, o.amount_micro,
     'Refund from a seller', o.reference || ':refund', 'completed',
     jsonb_build_object('order_id', o.id, 'seller', o.seller_id, 'reason', p_reason));

  RETURN TRUE;
END;
$$;
REVOKE ALL ON FUNCTION public.pawa_refund(BIGINT,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pawa_refund(BIGINT,TEXT) TO service_role;

-- ── mark a paid escrow order disputed (blocks auto-release; buyer only) ────────
CREATE OR REPLACE FUNCTION public.pawa_dispute(
  p_order_id BIGINT,
  p_buyer    UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE o public.pawa_orders%rowtype;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_buyer THEN
    RAISE EXCEPTION 'pawa_dispute: unauthorized';
  END IF;
  SELECT * INTO o FROM public.pawa_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND OR o.status <> 'paid' THEN RETURN FALSE; END IF;
  IF o.buyer_id <> p_buyer THEN RAISE EXCEPTION 'pawa_dispute: only the buyer can dispute'; END IF;
  UPDATE public.pawa_orders SET status = 'disputed', updated_at = now() WHERE id = o.id;
  RETURN TRUE;
END;
$$;
REVOKE ALL ON FUNCTION public.pawa_dispute(BIGINT,UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pawa_dispute(BIGINT,UUID) TO service_role;

-- ── cancel an UNPAID order (link never used; seller or nobody paid) ────────────
CREATE OR REPLACE FUNCTION public.pawa_cancel(
  p_order_id BIGINT,
  p_actor    UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE o public.pawa_orders%rowtype;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_actor THEN
    RAISE EXCEPTION 'pawa_cancel: unauthorized';
  END IF;
  SELECT * INTO o FROM public.pawa_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND OR o.status <> 'pending' THEN RETURN FALSE; END IF; -- only unpaid orders; idempotent
  IF o.seller_id <> p_actor THEN RAISE EXCEPTION 'pawa_cancel: only the seller can cancel'; END IF;
  UPDATE public.pawa_orders SET status = 'cancelled', updated_at = now() WHERE id = o.id;
  RETURN TRUE;
END;
$$;
REVOKE ALL ON FUNCTION public.pawa_cancel(BIGINT,UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pawa_cancel(BIGINT,UUID) TO service_role;
