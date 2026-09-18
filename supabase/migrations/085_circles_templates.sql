-- 085_circles_templates.sql
-- Product plan §3.3 "Circles — ajo, esusu, dues, group pools".
--
-- The existing esusu_groups tables already model a ROTATING ajo (schedule, rotation, in-group
-- ledger, defaulter strikes). This migration GENERALISES that same infrastructure into the full
-- "Circles" primitive without renaming or migrating any existing row:
--
--   • circle_type — the template a circle was created from (rotating_ajo | aso_ebi | event_dues |
--     harambee | group_buy | chama). Defaults to 'rotating_ajo' so every existing group keeps its
--     exact behaviour.
--   • payout_mode — how the pot leaves the circle:
--       rotating   → the existing ajo/esusu rotation payout (process_esusu_payout). Unchanged.
--       collection → one beneficiary receives the whole pot once (aso ebi, event dues, harambee,
--                    group buy — one settlement to the seller/celebrant/recipient).
--       investment → chama variant: the pot is pooled toward a shared investment, not a payout.
--   • goal_kobo / deadline / beneficiary_id / purpose — the collection-template fields.
--   • a per-circle CHAT THREAD (circle_messages), the "chat thread" the plan calls for.
--
-- Money safety mirrors 083 (p2p): every balance move is inside a SECURITY DEFINER RPC under
-- FOR UPDATE with a status guard, so retries and races can't double-spend. cNGN lives in
-- wallets.usdc_balance_micro (6dp, 1 NGN = 1 cNGN = 1_000_000 micro). Contributions can draw the
-- shortfall from the savings pool (cngn_pool_micro), exactly like esusu_contribute.

-- ── template + collection fields on the existing circle table ──────────────────
ALTER TABLE public.esusu_groups
  ADD COLUMN IF NOT EXISTS circle_type    TEXT NOT NULL DEFAULT 'rotating_ajo',
  ADD COLUMN IF NOT EXISTS payout_mode    TEXT NOT NULL DEFAULT 'rotating',
  ADD COLUMN IF NOT EXISTS goal_kobo      BIGINT,
  ADD COLUMN IF NOT EXISTS deadline       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS beneficiary_id UUID REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS purpose        TEXT,
  ADD COLUMN IF NOT EXISTS settled_at     TIMESTAMPTZ;

DO $$ BEGIN
  ALTER TABLE public.esusu_groups
    ADD CONSTRAINT esusu_groups_circle_type_check
    CHECK (circle_type IN ('rotating_ajo','aso_ebi','event_dues','harambee','group_buy','chama'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.esusu_groups
    ADD CONSTRAINT esusu_groups_payout_mode_check
    CHECK (payout_mode IN ('rotating','collection','investment'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A 'settled' state for collection circles once the beneficiary has been paid. Keep the existing
-- values intact so rotating circles are unaffected.
DO $$ BEGIN
  ALTER TABLE public.esusu_groups DROP CONSTRAINT IF EXISTS esusu_groups_status_check;
  ALTER TABLE public.esusu_groups ADD CONSTRAINT esusu_groups_status_check
    CHECK (status IN ('forming','active','completed','settled'));
EXCEPTION WHEN others THEN NULL; END $$;

-- ── circle chat thread ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.circle_messages (
  id         BIGSERIAL PRIMARY KEY,
  group_id   UUID NOT NULL REFERENCES public.esusu_groups(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  body       TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_circle_messages_group ON public.circle_messages (group_id, created_at DESC);

ALTER TABLE public.circle_messages ENABLE ROW LEVEL SECURITY;
-- Visible only to circle members (the plan: "shared in-group ledger ... visible only to the circle").
DROP POLICY IF EXISTS circle_messages_member_read ON public.circle_messages;
CREATE POLICY circle_messages_member_read ON public.circle_messages FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.esusu_members m WHERE m.group_id = circle_messages.group_id AND m.user_id = auth.uid())
);
DROP POLICY IF EXISTS circle_messages_member_write ON public.circle_messages;
CREATE POLICY circle_messages_member_write ON public.circle_messages FOR INSERT WITH CHECK (
  auth.uid() = user_id
  AND EXISTS (SELECT 1 FROM public.esusu_members m WHERE m.group_id = circle_messages.group_id AND m.user_id = auth.uid())
);

-- ── contribute to a COLLECTION / INVESTMENT circle ────────────────────────────
-- Rotating ajo keeps using esusu_contribute (penalty/strike logic tied to cycles). Collection
-- and investment circles have no rotation, so contributions are a plain "pay into the pot": debit
-- the member's cNGN (spendable, topping up from the savings pool if short) and add it to the pot.
-- Idempotent on the reference. Membership is required.
CREATE OR REPLACE FUNCTION public.circle_contribute(
  p_user_id      UUID,
  p_group_id     UUID,
  p_amount_kobo  BIGINT,
  p_reference    TEXT,
  p_note         TEXT DEFAULT NULL
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  g          public.esusu_groups%rowtype;
  w          public.wallets%rowtype;
  v_member   public.esusu_members%rowtype;
  v_micro    BIGINT := p_amount_kobo * 10000;
  v_from_pool BIGINT;
  v_gname    TEXT;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'circle_contribute: unauthorized';
  END IF;
  IF p_amount_kobo <= 0 THEN RAISE EXCEPTION 'circle_contribute: amount must be positive'; END IF;

  SELECT * INTO g FROM public.esusu_groups WHERE id = p_group_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'circle_contribute: circle not found'; END IF;
  IF g.payout_mode = 'rotating' THEN
    RAISE EXCEPTION 'circle_contribute: use esusu_contribute for rotating ajo';
  END IF;
  IF g.status NOT IN ('forming','active') THEN
    RAISE EXCEPTION 'circle_contribute: circle is % — not accepting contributions', g.status;
  END IF;

  SELECT * INTO v_member FROM public.esusu_members
    WHERE group_id = p_group_id AND user_id = p_user_id AND NOT COALESCE(removed, FALSE)
    LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'circle_contribute: not a member of this circle'; END IF;

  -- Idempotency: one contribution per reference.
  IF EXISTS (SELECT 1 FROM public.transactions WHERE reference = p_reference) THEN
    RETURN TRUE;
  END IF;

  SELECT * INTO w FROM public.wallets WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND OR (w.usdc_balance_micro + COALESCE(w.cngn_pool_micro,0)) < v_micro THEN
    RAISE EXCEPTION 'circle_contribute: insufficient balance';
  END IF;

  -- Top spendable up from the savings pool if it's short (same as esusu_contribute).
  IF w.usdc_balance_micro < v_micro THEN
    v_from_pool := v_micro - w.usdc_balance_micro;
    UPDATE public.wallets
      SET cngn_pool_micro   = cngn_pool_micro - v_from_pool,
          usdc_balance_micro = usdc_balance_micro + v_from_pool
      WHERE user_id = p_user_id;
  END IF;

  UPDATE public.wallets
    SET usdc_balance_micro = usdc_balance_micro - v_micro, updated_at = now()
    WHERE user_id = p_user_id;

  -- Collections take the full amount to the pot (no rotation emergency-pot split).
  UPDATE public.esusu_groups
    SET pot_balance_kobo = pot_balance_kobo + p_amount_kobo,
        status = CASE WHEN status = 'forming' THEN 'active' ELSE status END
    WHERE id = p_group_id;

  SELECT name INTO v_gname FROM public.esusu_groups WHERE id = p_group_id;

  -- In-group ledger row (cycle_number 0 = a collection, not a rotation cycle).
  INSERT INTO public.esusu_contributions (group_id, member_id, cycle_number, amount_kobo)
  VALUES (p_group_id, v_member.id, 0, p_amount_kobo);

  INSERT INTO public.transactions
    (user_id, type, direction, amount_kobo, amount_usdc_micro, description, reference, status, metadata)
  VALUES
    (p_user_id, 'esusu_contribute', 'debit', p_amount_kobo, v_micro,
     'Contributed to "' || COALESCE(v_gname,'Circle') || '"', p_reference, 'completed',
     jsonb_build_object('circle_id', p_group_id, 'circle_type', g.circle_type, 'note', p_note));

  RETURN TRUE;
END;
$$;
REVOKE ALL ON FUNCTION public.circle_contribute(UUID,UUID,BIGINT,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.circle_contribute(UUID,UUID,BIGINT,TEXT,TEXT) TO service_role;

-- ── settle a COLLECTION / GROUP-BUY circle to its beneficiary ─────────────────
-- Pays the whole pot to beneficiary_id in one move (the group-buy seller, the aso-ebi/harambee
-- recipient, the celebrant). Only the owner or the beneficiary may trigger it. Idempotent: the
-- status flip to 'settled' under FOR UPDATE guarantees the credit runs at most once.
CREATE OR REPLACE FUNCTION public.circle_settle(
  p_group_id UUID,
  p_actor    UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  g        public.esusu_groups%rowtype;
  v_micro  BIGINT;
  v_kobo   BIGINT;
  v_ref    TEXT;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_actor THEN
    RAISE EXCEPTION 'circle_settle: unauthorized';
  END IF;

  SELECT * INTO g FROM public.esusu_groups WHERE id = p_group_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'circle_settle: circle not found'; END IF;
  IF g.payout_mode NOT IN ('collection','investment') THEN
    RAISE EXCEPTION 'circle_settle: only collection/investment circles settle this way';
  END IF;
  IF g.beneficiary_id IS NULL THEN RAISE EXCEPTION 'circle_settle: no beneficiary set'; END IF;
  IF p_actor <> g.owner_id AND p_actor <> g.beneficiary_id THEN
    RAISE EXCEPTION 'circle_settle: only the owner or beneficiary can settle';
  END IF;
  IF g.status = 'settled' THEN RETURN TRUE; END IF; -- idempotent
  IF g.status NOT IN ('forming','active') THEN
    RAISE EXCEPTION 'circle_settle: circle is % — cannot settle', g.status;
  END IF;

  v_kobo  := g.pot_balance_kobo;
  v_micro := v_kobo * 10000;

  UPDATE public.esusu_groups
    SET status = 'settled', pot_balance_kobo = 0, settled_at = now()
    WHERE id = p_group_id;

  IF v_micro > 0 THEN
    UPDATE public.wallets
      SET usdc_balance_micro = usdc_balance_micro + v_micro, updated_at = now()
      WHERE user_id = g.beneficiary_id;

    v_ref := 'circle_settle_' || p_group_id::text;
    INSERT INTO public.transactions
      (user_id, type, direction, amount_kobo, amount_usdc_micro, description, reference, status, metadata)
    VALUES
      (g.beneficiary_id, 'esusu_payout', 'credit', v_kobo, v_micro,
       'Received from "' || COALESCE(g.name,'Circle') || '"', v_ref, 'completed',
       jsonb_build_object('circle_id', p_group_id, 'circle_type', g.circle_type));
  END IF;

  RETURN TRUE;
END;
$$;
REVOKE ALL ON FUNCTION public.circle_settle(UUID,UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.circle_settle(UUID,UUID) TO service_role;
