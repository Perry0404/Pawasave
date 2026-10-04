-- 116_cooperatives.sql  (run after 115)
-- Cooperative societies: recurring dues, a shared fund run by officers, and every naira of it
-- earning while it sits.
--
-- WHAT A COOPERATIVE IS HERE
--   * Members join with the society's code. Each pays an optional entrance fee once, then dues
--     every period (weekly / monthly / quarterly / yearly). Officers can also raise a one-off
--     levy on every member.
--   * Dues are CHARGES: coop_run_dues() raises one per active member each period, so the
--     society always knows who has paid and who owes. Members with auto-pay on are debited
--     from their spendable balance automatically; anyone can pay what they owe in one tap.
--   * The money sits in the society's FUND. No single person can move it: an officer proposes
--     a payout (to a PawaSave user, for a stated reason) and it only executes once the
--     required number of officers (default 2) approve. Every member sees every proposal,
--     vote and movement in the fund ledger.
--   * The fund earns the Ajo rate daily (accrue_coop_interest), only while savings are backed
--     by gNTB (yield_backing_apy_percent > 0, see 115). The interest is added to the fund; our
--     spread is booked as revenue the same day. savings-gntb-sync counts the funds in its
--     target, so the money is invested 1:1 like Goals and Ajo.
--
-- ROLES: chairman (one; appoints officers, removes members), treasurer, secretary, officer
-- (all can propose and approve payouts and raise levies), member.
--
-- ACCESS: every table is service-role only (RLS on, no policies). The app goes through
-- /api/coop/*, which checks the session and membership and calls the functions below with the
-- caller as p_actor. Every money move is in a SECURITY DEFINER function under FOR UPDATE.
--
-- MANUAL STEP: none. No data changes.

-- ── tables ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.cooperatives (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  TEXT NOT NULL CHECK (char_length(name) BETWEEN 2 AND 80),
  description           TEXT CHECK (description IS NULL OR char_length(description) <= 300),
  created_by            UUID NOT NULL REFERENCES public.profiles(id),
  join_code             TEXT NOT NULL UNIQUE,
  dues_amount_micro     BIGINT NOT NULL CHECK (dues_amount_micro >= 0),
  dues_period           TEXT NOT NULL CHECK (dues_period IN ('weekly','monthly','quarterly','yearly')),
  entrance_fee_micro    BIGINT NOT NULL DEFAULT 0 CHECK (entrance_fee_micro >= 0),
  approvals_required    INT NOT NULL DEFAULT 2 CHECK (approvals_required BETWEEN 1 AND 5),
  fund_balance_micro    BIGINT NOT NULL DEFAULT 0 CHECK (fund_balance_micro >= 0),
  interest_earned_micro BIGINT NOT NULL DEFAULT 0,          -- lifetime, for display
  current_period_label  TEXT NOT NULL,                      -- start date of the current dues period
  next_dues_at          TIMESTAMPTZ NOT NULL,
  status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.coop_members (
  id               BIGSERIAL PRIMARY KEY,
  coop_id          UUID NOT NULL REFERENCES public.cooperatives(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  role             TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('chairman','treasurer','secretary','officer','member')),
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','left','removed')),
  auto_pay         BOOLEAN NOT NULL DEFAULT TRUE,
  total_paid_micro BIGINT NOT NULL DEFAULT 0,
  joined_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (coop_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_coop_members_user ON public.coop_members (user_id);

-- One row per thing a member owes: entrance fee, each period's dues, each levy.
CREATE TABLE IF NOT EXISTS public.coop_charges (
  id           BIGSERIAL PRIMARY KEY,
  coop_id      UUID NOT NULL REFERENCES public.cooperatives(id) ON DELETE CASCADE,
  member_id    BIGINT NOT NULL REFERENCES public.coop_members(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('entrance','dues','levy')),
  label        TEXT NOT NULL,          -- period start date for dues, 'entrance', 'levy:<id>'
  memo         TEXT,
  amount_micro BIGINT NOT NULL CHECK (amount_micro > 0),
  status       TEXT NOT NULL DEFAULT 'owing' CHECK (status IN ('owing','paid','waived')),
  due_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at      TIMESTAMPTZ,
  UNIQUE (member_id, kind, label)
);
CREATE INDEX IF NOT EXISTS idx_coop_charges_owing ON public.coop_charges (member_id, due_at) WHERE status = 'owing';
CREATE INDEX IF NOT EXISTS idx_coop_charges_coop ON public.coop_charges (coop_id, label);

CREATE TABLE IF NOT EXISTS public.coop_disbursements (
  id           BIGSERIAL PRIMARY KEY,
  coop_id      UUID NOT NULL REFERENCES public.cooperatives(id) ON DELETE CASCADE,
  proposed_by  UUID NOT NULL REFERENCES public.profiles(id),
  recipient_id UUID NOT NULL REFERENCES public.profiles(id),
  amount_micro BIGINT NOT NULL CHECK (amount_micro > 0),
  reason       TEXT NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 300),
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','executed','rejected','expired','cancelled')),
  expires_at   TIMESTAMPTZ NOT NULL DEFAULT now() + interval '7 days',
  executed_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_coop_disb_coop ON public.coop_disbursements (coop_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.coop_approvals (
  disbursement_id BIGINT NOT NULL REFERENCES public.coop_disbursements(id) ON DELETE CASCADE,
  officer_id      UUID NOT NULL REFERENCES public.profiles(id),
  approve         BOOLEAN NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (disbursement_id, officer_id)
);

-- Every movement in or out of the fund, visible to all members.
CREATE TABLE IF NOT EXISTS public.coop_ledger (
  id           BIGSERIAL PRIMARY KEY,
  coop_id      UUID NOT NULL REFERENCES public.cooperatives(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('entrance','dues','levy','interest','payout')),
  amount_micro BIGINT NOT NULL,        -- positive in, negative out
  user_id      UUID REFERENCES public.profiles(id),
  memo         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_coop_ledger_coop ON public.coop_ledger (coop_id, created_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cooperatives','coop_members','coop_charges','coop_disbursements','coop_approvals','coop_ledger'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
  END LOOP;
END $$;

INSERT INTO public.platform_settings (key, value) VALUES ('coop_interest_last_accrued_on', '1970-01-01')
ON CONFLICT (key) DO NOTHING;

-- Two new ledger types for members' statements. NOT VALID: enforce for new rows without
-- re-checking history.
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
  'pawa_pay', 'pawa_receive', 'pawa_refund',
  'coop_dues', 'coop_payout'
)) NOT VALID;

-- ── helpers (internal, no grants) ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._coop_interval(p_period text)
RETURNS interval LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_period WHEN 'weekly' THEN interval '7 days' WHEN 'monthly' THEN interval '1 month'
                       WHEN 'quarterly' THEN interval '3 months' ELSE interval '1 year' END;
$$;
REVOKE ALL ON FUNCTION public._coop_interval(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._coop_is_officer(p_role text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT p_role IN ('chairman','treasurer','secretary','officer');
$$;
REVOKE ALL ON FUNCTION public._coop_is_officer(text) FROM PUBLIC, anon, authenticated;

-- Pays a member's owing charges, oldest first, as far as their balance covers WHOLE charges.
-- p_use_pool: also draw on the savings pool (manual pay yes, auto-pay no).
CREATE OR REPLACE FUNCTION public._coop_pay_charges(p_member_id bigint, p_use_pool boolean, p_reference text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  m        public.coop_members%rowtype;
  c        public.cooperatives%rowtype;
  w        public.wallets%rowtype;
  ch       record;
  v_avail  bigint;
  v_from_pool bigint;
  v_paid   bigint := 0;
  v_count  int := 0;
BEGIN
  SELECT * INTO m FROM public.coop_members WHERE id = p_member_id FOR UPDATE;
  IF NOT FOUND OR m.status <> 'active' THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_member'); END IF;
  SELECT * INTO c FROM public.cooperatives WHERE id = m.coop_id FOR UPDATE;
  IF c.status <> 'active' THEN RETURN jsonb_build_object('ok', false, 'reason', 'closed'); END IF;
  SELECT * INTO w FROM public.wallets WHERE user_id = m.user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_wallet'); END IF;

  v_avail := w.usdc_balance_micro + CASE WHEN p_use_pool THEN COALESCE(w.cngn_pool_micro, 0) ELSE 0 END;

  FOR ch IN
    SELECT id, kind, label, amount_micro FROM public.coop_charges
    WHERE member_id = p_member_id AND status = 'owing'
    ORDER BY due_at, id
    FOR UPDATE
  LOOP
    EXIT WHEN ch.amount_micro > v_avail;
    UPDATE public.coop_charges SET status = 'paid', paid_at = now() WHERE id = ch.id;
    INSERT INTO public.coop_ledger (coop_id, kind, amount_micro, user_id, memo)
    VALUES (c.id, ch.kind, ch.amount_micro, m.user_id,
            CASE ch.kind WHEN 'dues' THEN 'Dues for period from ' || ch.label
                         WHEN 'entrance' THEN 'Entrance fee' ELSE 'Levy' END);
    v_avail := v_avail - ch.amount_micro;
    v_paid  := v_paid + ch.amount_micro;
    v_count := v_count + 1;
  END LOOP;

  IF v_count = 0 THEN
    RETURN jsonb_build_object('ok', true, 'paid_count', 0, 'paid_micro', 0,
      'reason', CASE WHEN EXISTS (SELECT 1 FROM public.coop_charges WHERE member_id = p_member_id AND status = 'owing')
                     THEN 'insufficient' ELSE 'nothing_owing' END);
  END IF;

  -- Spendable first, then the savings pool for any shortfall (only when allowed).
  IF w.usdc_balance_micro < v_paid THEN
    v_from_pool := v_paid - w.usdc_balance_micro;
    UPDATE public.wallets SET cngn_pool_micro = cngn_pool_micro - v_from_pool,
                              usdc_balance_micro = usdc_balance_micro + v_from_pool
    WHERE user_id = m.user_id;
  END IF;
  UPDATE public.wallets SET usdc_balance_micro = usdc_balance_micro - v_paid, updated_at = now()
  WHERE user_id = m.user_id;

  UPDATE public.cooperatives SET fund_balance_micro = fund_balance_micro + v_paid WHERE id = c.id;
  UPDATE public.coop_members SET total_paid_micro = total_paid_micro + v_paid WHERE id = p_member_id;

  INSERT INTO public.transactions
    (user_id, type, direction, amount_kobo, amount_usdc_micro, description, reference, status, metadata)
  VALUES
    (m.user_id, 'coop_dues', 'debit', floor(v_paid / 10000), v_paid,
     format('Paid %s to "%s"', CASE WHEN v_count = 1 THEN '1 charge' ELSE v_count || ' charges' END, c.name),
     p_reference, 'completed', jsonb_build_object('coop_id', c.id, 'charges', v_count));

  RETURN jsonb_build_object('ok', true, 'paid_count', v_count, 'paid_micro', v_paid);
END;
$$;
REVOKE ALL ON FUNCTION public._coop_pay_charges(bigint, boolean, text) FROM PUBLIC, anon, authenticated;

-- Moves an approved payout out of the fund. Caller holds the disbursement row lock.
CREATE OR REPLACE FUNCTION public._coop_execute(p_disb_id bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  d public.coop_disbursements%rowtype;
  c public.cooperatives%rowtype;
BEGIN
  SELECT * INTO d FROM public.coop_disbursements WHERE id = p_disb_id FOR UPDATE;
  IF d.status <> 'pending' THEN RETURN jsonb_build_object('ok', false, 'reason', d.status); END IF;
  SELECT * INTO c FROM public.cooperatives WHERE id = d.coop_id FOR UPDATE;
  IF c.fund_balance_micro < d.amount_micro THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'insufficient_fund');
  END IF;

  UPDATE public.cooperatives SET fund_balance_micro = fund_balance_micro - d.amount_micro WHERE id = c.id;
  UPDATE public.coop_disbursements SET status = 'executed', executed_at = now() WHERE id = d.id;
  UPDATE public.wallets SET usdc_balance_micro = usdc_balance_micro + d.amount_micro, updated_at = now()
  WHERE user_id = d.recipient_id;
  INSERT INTO public.coop_ledger (coop_id, kind, amount_micro, user_id, memo)
  VALUES (c.id, 'payout', -d.amount_micro, d.recipient_id, d.reason);
  INSERT INTO public.transactions
    (user_id, type, direction, amount_kobo, amount_usdc_micro, description, reference, status, metadata)
  VALUES
    (d.recipient_id, 'coop_payout', 'credit', floor(d.amount_micro / 10000), d.amount_micro,
     format('From "%s": %s', c.name, d.reason), 'coop_disb_' || d.id, 'completed',
     jsonb_build_object('coop_id', c.id, 'disbursement_id', d.id));
  RETURN jsonb_build_object('ok', true, 'executed', true);
END;
$$;
REVOKE ALL ON FUNCTION public._coop_execute(bigint) FROM PUBLIC, anon, authenticated;

-- ── create / join / leave ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.coop_create(
  p_actor uuid, p_name text, p_description text, p_dues_micro bigint, p_period text,
  p_entrance_micro bigint, p_approvals int
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_code  text;
  v_id    uuid;
  v_mid   bigint;
  v_label text := to_char((now() AT TIME ZONE 'utc')::date, 'YYYY-MM-DD');
BEGIN
  IF p_period NOT IN ('weekly','monthly','quarterly','yearly') THEN RAISE EXCEPTION 'coop: bad dues period'; END IF;
  IF COALESCE(p_dues_micro, 0) < 0 OR COALESCE(p_entrance_micro, 0) < 0 THEN RAISE EXCEPTION 'coop: amounts must not be negative'; END IF;
  IF (SELECT count(*) FROM public.cooperatives WHERE created_by = p_actor AND status = 'active') >= 10 THEN
    RAISE EXCEPTION 'coop: too many societies';
  END IF;

  LOOP
    -- Hex: no O/I/L to misread when the code is read out at a meeting.
    v_code := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 7));
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.cooperatives WHERE join_code = v_code);
  END LOOP;

  INSERT INTO public.cooperatives (name, description, created_by, join_code, dues_amount_micro, dues_period,
                                   entrance_fee_micro, approvals_required, current_period_label, next_dues_at)
  VALUES (trim(p_name), NULLIF(trim(COALESCE(p_description, '')), ''), p_actor, v_code, COALESCE(p_dues_micro, 0), p_period,
          COALESCE(p_entrance_micro, 0), COALESCE(p_approvals, 2), v_label, now() + public._coop_interval(p_period))
  RETURNING id INTO v_id;

  INSERT INTO public.coop_members (coop_id, user_id, role) VALUES (v_id, p_actor, 'chairman') RETURNING id INTO v_mid;
  -- The founder pays this period's dues like everyone else (no entrance fee for the founder).
  IF COALESCE(p_dues_micro, 0) > 0 THEN
    INSERT INTO public.coop_charges (coop_id, member_id, kind, label, amount_micro)
    VALUES (v_id, v_mid, 'dues', v_label, p_dues_micro);
  END IF;

  RETURN jsonb_build_object('ok', true, 'id', v_id, 'join_code', v_code);
END;
$$;

CREATE OR REPLACE FUNCTION public.coop_join(p_actor uuid, p_code text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  c     public.cooperatives%rowtype;
  m     public.coop_members%rowtype;
  v_mid bigint;
BEGIN
  SELECT * INTO c FROM public.cooperatives WHERE join_code = upper(trim(p_code)) FOR UPDATE;
  IF NOT FOUND OR c.status <> 'active' THEN RAISE EXCEPTION 'coop: no society with that code'; END IF;

  SELECT * INTO m FROM public.coop_members WHERE coop_id = c.id AND user_id = p_actor FOR UPDATE;
  IF FOUND THEN
    IF m.status = 'active'  THEN RETURN jsonb_build_object('ok', true, 'id', c.id, 'already', true); END IF;
    IF m.status = 'removed' THEN RAISE EXCEPTION 'coop: you were removed from this society'; END IF;
    UPDATE public.coop_members SET status = 'active', role = 'member', joined_at = now() WHERE id = m.id;
    v_mid := m.id;
  ELSE
    IF (SELECT count(*) FROM public.coop_members WHERE coop_id = c.id AND status = 'active') >= 1000 THEN
      RAISE EXCEPTION 'coop: society is full';
    END IF;
    INSERT INTO public.coop_members (coop_id, user_id) VALUES (c.id, p_actor) RETURNING id INTO v_mid;
  END IF;

  IF c.entrance_fee_micro > 0 THEN
    INSERT INTO public.coop_charges (coop_id, member_id, kind, label, amount_micro)
    VALUES (c.id, v_mid, 'entrance', 'entrance', c.entrance_fee_micro) ON CONFLICT DO NOTHING;
  END IF;
  IF c.dues_amount_micro > 0 THEN
    INSERT INTO public.coop_charges (coop_id, member_id, kind, label, amount_micro)
    VALUES (c.id, v_mid, 'dues', c.current_period_label, c.dues_amount_micro) ON CONFLICT DO NOTHING;
  END IF;

  RETURN jsonb_build_object('ok', true, 'id', c.id, 'name', c.name);
END;
$$;

-- Leaving forgives what you still owe; dues already paid stay with the society.
CREATE OR REPLACE FUNCTION public.coop_leave(p_actor uuid, p_coop_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE m public.coop_members%rowtype;
BEGIN
  SELECT * INTO m FROM public.coop_members WHERE coop_id = p_coop_id AND user_id = p_actor AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'coop: not a member'; END IF;
  IF m.role = 'chairman' THEN RAISE EXCEPTION 'coop: hand the chair to another member before leaving'; END IF;
  UPDATE public.coop_members SET status = 'left', role = 'member' WHERE id = m.id;
  UPDATE public.coop_charges SET status = 'waived' WHERE member_id = m.id AND status = 'owing';
  RETURN jsonb_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.coop_set_autopay(p_actor uuid, p_coop_id uuid, p_on boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE public.coop_members SET auto_pay = p_on WHERE coop_id = p_coop_id AND user_id = p_actor AND status = 'active';
  IF NOT FOUND THEN RAISE EXCEPTION 'coop: not a member'; END IF;
  RETURN jsonb_build_object('ok', true, 'auto_pay', p_on);
END;
$$;

-- ── pay dues ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.coop_pay(p_actor uuid, p_coop_id uuid, p_reference text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_mid bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM public.transactions WHERE reference = p_reference) THEN
    RETURN jsonb_build_object('ok', true, 'duplicate', true);
  END IF;
  SELECT id INTO v_mid FROM public.coop_members WHERE coop_id = p_coop_id AND user_id = p_actor AND status = 'active';
  IF NOT FOUND THEN RAISE EXCEPTION 'coop: not a member'; END IF;
  RETURN public._coop_pay_charges(v_mid, true, p_reference);
END;
$$;

-- ── officers ──────────────────────────────────────────────────────────────────
-- Chairman only. Making someone chairman hands over the chair: the old chairman becomes an officer.
CREATE OR REPLACE FUNCTION public.coop_set_role(p_actor uuid, p_coop_id uuid, p_user uuid, p_role text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  me  public.coop_members%rowtype;
  tgt public.coop_members%rowtype;
BEGIN
  IF p_role NOT IN ('chairman','treasurer','secretary','officer','member') THEN RAISE EXCEPTION 'coop: bad role'; END IF;
  PERFORM 1 FROM public.cooperatives WHERE id = p_coop_id FOR UPDATE;
  SELECT * INTO me FROM public.coop_members WHERE coop_id = p_coop_id AND user_id = p_actor AND status = 'active';
  IF NOT FOUND OR me.role <> 'chairman' THEN RAISE EXCEPTION 'coop: only the chairman can change roles'; END IF;
  IF p_user = p_actor THEN RAISE EXCEPTION 'coop: hand the chair to someone else instead'; END IF;
  SELECT * INTO tgt FROM public.coop_members WHERE coop_id = p_coop_id AND user_id = p_user AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'coop: not a member'; END IF;

  UPDATE public.coop_members SET role = p_role WHERE id = tgt.id;
  IF p_role = 'chairman' THEN
    UPDATE public.coop_members SET role = 'officer' WHERE id = me.id;
  END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.coop_remove_member(p_actor uuid, p_coop_id uuid, p_user uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE tgt public.coop_members%rowtype;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.coop_members WHERE coop_id = p_coop_id AND user_id = p_actor AND status = 'active' AND role = 'chairman') THEN
    RAISE EXCEPTION 'coop: only the chairman can remove members';
  END IF;
  IF p_user = p_actor THEN RAISE EXCEPTION 'coop: the chairman cannot remove themselves'; END IF;
  SELECT * INTO tgt FROM public.coop_members WHERE coop_id = p_coop_id AND user_id = p_user AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'coop: not a member'; END IF;
  UPDATE public.coop_members SET status = 'removed', role = 'member' WHERE id = tgt.id;
  UPDATE public.coop_charges SET status = 'waived' WHERE member_id = tgt.id AND status = 'owing';
  -- Their votes on open payouts no longer count; re-check nothing here (counts are live).
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- One-off levy on every active member (an event, a project). Officers only.
CREATE OR REPLACE FUNCTION public.coop_raise_levy(p_actor uuid, p_coop_id uuid, p_amount_micro bigint, p_memo text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_role  text;
  v_label text := 'levy:' || substr(md5(random()::text || clock_timestamp()::text), 1, 10);
  v_n     int;
BEGIN
  IF COALESCE(p_amount_micro, 0) <= 0 THEN RAISE EXCEPTION 'coop: levy must be positive'; END IF;
  IF char_length(trim(COALESCE(p_memo, ''))) < 3 THEN RAISE EXCEPTION 'coop: say what the levy is for'; END IF;
  SELECT role INTO v_role FROM public.coop_members WHERE coop_id = p_coop_id AND user_id = p_actor AND status = 'active';
  IF NOT FOUND OR NOT public._coop_is_officer(v_role) THEN RAISE EXCEPTION 'coop: only officers can raise a levy'; END IF;

  INSERT INTO public.coop_charges (coop_id, member_id, kind, label, memo, amount_micro)
  SELECT p_coop_id, id, 'levy', v_label, trim(p_memo), p_amount_micro
  FROM public.coop_members WHERE coop_id = p_coop_id AND status = 'active';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'members', v_n);
END;
$$;

-- ── payouts: propose → officers approve → executes ────────────────────────────
CREATE OR REPLACE FUNCTION public.coop_propose_payout(
  p_actor uuid, p_coop_id uuid, p_recipient uuid, p_amount_micro bigint, p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  c        public.cooperatives%rowtype;
  v_role   text;
  v_officers int;
  v_id     bigint;
BEGIN
  SELECT * INTO c FROM public.cooperatives WHERE id = p_coop_id FOR UPDATE;
  IF NOT FOUND OR c.status <> 'active' THEN RAISE EXCEPTION 'coop: society not found'; END IF;
  SELECT role INTO v_role FROM public.coop_members WHERE coop_id = p_coop_id AND user_id = p_actor AND status = 'active';
  IF NOT FOUND OR NOT public._coop_is_officer(v_role) THEN RAISE EXCEPTION 'coop: only officers can propose a payout'; END IF;
  IF COALESCE(p_amount_micro, 0) <= 0 THEN RAISE EXCEPTION 'coop: amount must be positive'; END IF;
  IF p_amount_micro > c.fund_balance_micro THEN RAISE EXCEPTION 'coop: more than the fund holds'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_recipient) THEN RAISE EXCEPTION 'coop: recipient not found'; END IF;

  SELECT count(*) INTO v_officers FROM public.coop_members
  WHERE coop_id = p_coop_id AND status = 'active' AND public._coop_is_officer(role);
  IF v_officers < c.approvals_required THEN
    RAISE EXCEPTION 'coop: payouts need % officer approvals; appoint more officers first', c.approvals_required;
  END IF;
  IF (SELECT count(*) FROM public.coop_disbursements WHERE coop_id = p_coop_id AND status = 'pending') >= 10 THEN
    RAISE EXCEPTION 'coop: too many open payouts';
  END IF;

  INSERT INTO public.coop_disbursements (coop_id, proposed_by, recipient_id, amount_micro, reason)
  VALUES (p_coop_id, p_actor, p_recipient, p_amount_micro, trim(p_reason)) RETURNING id INTO v_id;
  INSERT INTO public.coop_approvals (disbursement_id, officer_id, approve) VALUES (v_id, p_actor, true);

  IF c.approvals_required <= 1 THEN
    RETURN public._coop_execute(v_id) || jsonb_build_object('id', v_id);
  END IF;
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'executed', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.coop_vote_payout(p_actor uuid, p_disb_id bigint, p_approve boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  d          public.coop_disbursements%rowtype;
  c          public.cooperatives%rowtype;
  v_role     text;
  v_yes      int;
  v_no       int;
  v_officers int;
BEGIN
  SELECT * INTO d FROM public.coop_disbursements WHERE id = p_disb_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'coop: payout not found'; END IF;
  IF d.status <> 'pending' THEN RETURN jsonb_build_object('ok', false, 'reason', d.status); END IF;
  IF d.expires_at < now() THEN
    UPDATE public.coop_disbursements SET status = 'expired' WHERE id = d.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'expired');
  END IF;
  SELECT * INTO c FROM public.cooperatives WHERE id = d.coop_id;
  SELECT role INTO v_role FROM public.coop_members WHERE coop_id = d.coop_id AND user_id = p_actor AND status = 'active';
  IF NOT FOUND OR NOT public._coop_is_officer(v_role) THEN RAISE EXCEPTION 'coop: only officers can approve payouts'; END IF;
  IF EXISTS (SELECT 1 FROM public.coop_approvals WHERE disbursement_id = d.id AND officer_id = p_actor) THEN
    RAISE EXCEPTION 'coop: you have already voted';
  END IF;

  INSERT INTO public.coop_approvals (disbursement_id, officer_id, approve) VALUES (d.id, p_actor, p_approve);

  -- Only votes from people who are officers right now count.
  SELECT count(*) FILTER (WHERE a.approve), count(*) FILTER (WHERE NOT a.approve)
  INTO v_yes, v_no
  FROM public.coop_approvals a
  JOIN public.coop_members m ON m.coop_id = d.coop_id AND m.user_id = a.officer_id
  WHERE a.disbursement_id = d.id AND m.status = 'active' AND public._coop_is_officer(m.role);
  SELECT count(*) INTO v_officers FROM public.coop_members
  WHERE coop_id = d.coop_id AND status = 'active' AND public._coop_is_officer(role);

  IF v_yes >= c.approvals_required THEN
    RETURN public._coop_execute(d.id);
  END IF;
  IF v_officers - v_no < c.approvals_required THEN
    UPDATE public.coop_disbursements SET status = 'rejected' WHERE id = d.id;
    RETURN jsonb_build_object('ok', true, 'rejected', true);
  END IF;
  RETURN jsonb_build_object('ok', true, 'approvals', v_yes, 'needed', c.approvals_required);
END;
$$;

-- The proposer can withdraw their own pending payout.
CREATE OR REPLACE FUNCTION public.coop_cancel_payout(p_actor uuid, p_disb_id bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE public.coop_disbursements SET status = 'cancelled'
  WHERE id = p_disb_id AND proposed_by = p_actor AND status = 'pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'coop: nothing to cancel'; END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- ── scheduled jobs ────────────────────────────────────────────────────────────
-- Hourly: expire stale payouts, raise each due period's dues, then auto-pay for members who
-- have it on (spendable balance only; a member who can't cover it simply stays owing).
CREATE OR REPLACE FUNCTION public.coop_run_dues()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  c        record;
  m        record;
  v_label  text;
  v_raised int := 0;
  v_expired int;
  v_auto   int := 0;
  v_res    jsonb;
BEGIN
  UPDATE public.coop_disbursements SET status = 'expired' WHERE status = 'pending' AND expires_at < now();
  GET DIAGNOSTICS v_expired = ROW_COUNT;

  FOR c IN
    SELECT id, dues_amount_micro, dues_period, next_dues_at FROM public.cooperatives
    WHERE status = 'active' AND next_dues_at <= now()
    FOR UPDATE SKIP LOCKED
  LOOP
    v_label := to_char((c.next_dues_at AT TIME ZONE 'utc')::date, 'YYYY-MM-DD');
    IF c.dues_amount_micro > 0 THEN
      INSERT INTO public.coop_charges (coop_id, member_id, kind, label, amount_micro, due_at)
      SELECT c.id, id, 'dues', v_label, c.dues_amount_micro, c.next_dues_at
      FROM public.coop_members WHERE coop_id = c.id AND status = 'active'
      ON CONFLICT DO NOTHING;
      v_raised := v_raised + 1;
    END IF;
    -- One period per run; a society that fell behind catches up an hour at a time.
    UPDATE public.cooperatives
    SET current_period_label = v_label, next_dues_at = c.next_dues_at + public._coop_interval(c.dues_period)
    WHERE id = c.id;
  END LOOP;

  FOR m IN
    SELECT DISTINCT cm.id FROM public.coop_members cm
    JOIN public.coop_charges ch ON ch.member_id = cm.id AND ch.status = 'owing'
    WHERE cm.status = 'active' AND cm.auto_pay
  LOOP
    BEGIN
      v_res := public._coop_pay_charges(m.id, false, 'coop_auto_' || m.id || '_' || gen_random_uuid());
      IF COALESCE((v_res->>'paid_count')::int, 0) > 0 THEN v_auto := v_auto + 1; END IF;
    EXCEPTION WHEN others THEN
      RAISE WARNING 'coop autopay member %: %', m.id, SQLERRM;
    END;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'periods_raised', v_raised, 'autopaid_members', v_auto, 'expired_payouts', v_expired);
END;
$$;

-- Daily: the fund earns the Ajo rate on its actual balance while savings are backed by gNTB.
-- Interest goes into the fund; our spread is booked the same day. Idempotent per UTC day.
CREATE OR REPLACE FUNCTION public.accrue_coop_interest()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_today   date    := (now() AT TIME ZONE 'utc')::date;
  v_last    date    := COALESCE((SELECT value::date FROM public.platform_settings WHERE key = 'coop_interest_last_accrued_on'), '1970-01-01');
  v_rate    numeric := COALESCE((SELECT value::numeric FROM public.platform_settings WHERE key = 'ajo_user_apy_percent'), 10.5);
  v_backing numeric := COALESCE((SELECT value::numeric FROM public.platform_settings WHERE key = 'yield_backing_apy_percent'), 0);
  r         record;
  v_user_day bigint;
  v_spread  bigint;
  v_n       int    := 0;
  v_total   bigint := 0;
  v_spread_total bigint := 0;
BEGIN
  IF v_last >= v_today THEN RETURN jsonb_build_object('ok', true, 'skipped', 'already accrued today'); END IF;
  UPDATE public.platform_settings SET value = v_today::text WHERE key = 'coop_interest_last_accrued_on';
  IF v_backing <= 0 THEN RETURN jsonb_build_object('ok', true, 'skipped', 'not backed'); END IF;
  v_rate := LEAST(v_rate, v_backing);

  FOR r IN
    SELECT id, created_by, fund_balance_micro FROM public.cooperatives
    WHERE status = 'active' AND fund_balance_micro > 0
    FOR UPDATE
  LOOP
    v_user_day := floor(r.fund_balance_micro * (v_rate / 100.0) / 365.0);
    v_spread   := floor(r.fund_balance_micro * ((v_backing - v_rate) / 100.0) / 365.0);
    IF v_user_day > 0 THEN
      UPDATE public.cooperatives
      SET fund_balance_micro = fund_balance_micro + v_user_day, interest_earned_micro = interest_earned_micro + v_user_day
      WHERE id = r.id;
      INSERT INTO public.coop_ledger (coop_id, kind, amount_micro, memo)
      VALUES (r.id, 'interest', v_user_day, format('Interest at %s%% a year', v_rate));
      v_n := v_n + 1;
      v_total := v_total + v_user_day;
    END IF;
    IF v_spread > 0 THEN
      INSERT INTO public.revenue_journal (user_id, revenue_type, amount_usdc_micro, description)
      VALUES (r.created_by, 'yield_spread', v_spread, format('Coop spread (%s): backing %s%% - user %s%%', r.id, v_backing, v_rate));
      v_spread_total := v_spread_total + v_spread;
    END IF;
  END LOOP;

  IF v_spread_total > 0 THEN
    UPDATE public.platform_settings SET value = (COALESCE(value::bigint, 0) + floor(v_spread_total / 10000))::text
    WHERE key = 'platform_revenue_kobo';
  END IF;
  RETURN jsonb_build_object('ok', true, 'coops', v_n, 'interest_micro', v_total, 'spread_micro', v_spread_total);
END;
$$;

-- ── grants: service role only (the app calls these through /api/coop/*) ──────
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'coop_create(uuid,text,text,bigint,text,bigint,int)',
    'coop_join(uuid,text)',
    'coop_leave(uuid,uuid)',
    'coop_set_autopay(uuid,uuid,boolean)',
    'coop_pay(uuid,uuid,text)',
    'coop_set_role(uuid,uuid,uuid,text)',
    'coop_remove_member(uuid,uuid,uuid)',
    'coop_raise_levy(uuid,uuid,bigint,text)',
    'coop_propose_payout(uuid,uuid,uuid,bigint,text)',
    'coop_vote_payout(uuid,bigint,boolean)',
    'coop_cancel_payout(uuid,bigint)',
    'coop_run_dues()',
    'accrue_coop_interest()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END $$;
