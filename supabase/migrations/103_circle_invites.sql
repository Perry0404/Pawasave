-- 103_circle_invites.sql  (run after 102)
--
-- Tokenised circle invites, replacing "possession of the group id is membership".
--
-- Joining a circle today means opening /join/<group uuid> and calling join_esusu_group. The uuid is
-- the only credential: it never expires, cannot be revoked, works for anybody it is ever forwarded
-- to, and sits in the URL bar of every member who has joined. A circle is a shared pot of real
-- money, so that is the wrong shape.
--
-- It is also the shape we cannot port. The Next app's invite button calls create_ajo_invite
-- (groups-view.tsx:208) and that function has no definition anywhere in this repo — it is one of
-- the objects lost with migrations 046-055 / 057-061. So there is nothing to preserve and no body
-- to read, which is why this is a new table rather than a fix.
--
-- What changes for a user: an invite is a link with a token, it expires, the owner can revoke it,
-- and it can be capped to a number of uses. What does not change: no approval step, because the
-- owner chose to hand out the link.
--
-- Four RPCs, all service_role, because the app calls no membership RPC directly and the routes
-- derive the actor from the bearer:
--
--   circle_invite_create  owner mints a link
--   circle_invite_peek    what a stranger sees BEFORE signing in. No member identities.
--   circle_invite_redeem  re-validates under a lock, counts the use, and joins
--   circle_invite_revoke  cancels a link handed to the wrong person
--
-- Redeem delegates the seat logic to join_esusu_group (038) rather than repeating it. That function
-- guards on `auth.uid() IS NOT NULL AND auth.uid() <> p_user_id`, and as service_role auth.uid() is
-- null, so the check is skipped and its full / duplicate / completed handling is reused intact.

-- ── the table ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.circle_invites (
  token       text PRIMARY KEY,
  group_id    uuid NOT NULL REFERENCES public.esusu_groups(id) ON DELETE CASCADE,
  created_by  uuid NOT NULL REFERENCES public.profiles(id)     ON DELETE CASCADE,
  -- For the creator's own benefit, "the cousins" or "work lot". Never shown to a stranger.
  label       text,
  expires_at  timestamptz NOT NULL,
  -- 0 means unlimited within the expiry, which is what a link dropped in a group chat wants.
  max_uses    int NOT NULL DEFAULT 0 CHECK (max_uses >= 0),
  uses        int NOT NULL DEFAULT 0 CHECK (uses >= 0),
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_circle_invites_group
  ON public.circle_invites (group_id, created_at DESC);

ALTER TABLE public.circle_invites ENABLE ROW LEVEL SECURITY;

-- Members see their own circle's invites, to share or revoke one. Nobody writes from a client: a
-- client-minted invite is an invite with no expiry policy and no owner check.
DROP POLICY IF EXISTS circle_invites_member_read ON public.circle_invites;
CREATE POLICY circle_invites_member_read ON public.circle_invites FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM public.esusu_members m
    WHERE m.group_id = circle_invites.group_id AND m.user_id = auth.uid()
  )
);
REVOKE INSERT, UPDATE, DELETE ON public.circle_invites FROM anon, authenticated;

COMMENT ON TABLE public.circle_invites IS
  'Tokenised invites to a circle. Written only by circle_invite_create and circle_invite_redeem, '
  'both service_role. Replaces /join/<group uuid>, where the group id was the only credential and '
  'could neither expire nor be revoked. See 103.';

-- ── circle_invite_create ──────────────────────────────────────────────────────
-- Owner only. 16 random bytes as hex: 128 bits, url-safe, no ambiguous characters. Not shortened,
-- because these are shared as links rather than read aloud, and a guessable invite is a stranger in
-- a circle holding money.
CREATE OR REPLACE FUNCTION public.circle_invite_create(
  p_group_id  uuid,
  p_actor     uuid,
  p_label     text DEFAULT NULL,
  p_ttl_hours int  DEFAULT 168,   -- a week
  p_max_uses  int  DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  g        public.esusu_groups%rowtype;
  v_token  text;
  v_ttl    int := GREATEST(1, LEAST(COALESCE(p_ttl_hours, 168), 720));  -- 1 hour to 30 days
  v_uses   int := GREATEST(0, COALESCE(p_max_uses, 0));
  v_expiry timestamptz;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_actor THEN
    RAISE EXCEPTION 'circle_invite_create: unauthorized';
  END IF;

  SELECT * INTO g FROM public.esusu_groups WHERE id = p_group_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'circle_invite_create: circle not found'; END IF;
  IF g.owner_id <> p_actor THEN
    RAISE EXCEPTION 'circle_invite_create: only the circle owner can invite';
  END IF;
  IF g.status NOT IN ('forming', 'active') THEN
    RAISE EXCEPTION 'circle_invite_create: circle is % — nobody else can join', g.status;
  END IF;

  v_token  := encode(gen_random_bytes(16), 'hex');
  v_expiry := now() + make_interval(hours => v_ttl);

  INSERT INTO public.circle_invites (token, group_id, created_by, label, expires_at, max_uses)
  VALUES (v_token, p_group_id, p_actor, NULLIF(btrim(COALESCE(p_label, '')), ''), v_expiry, v_uses);

  RETURN jsonb_build_object(
    'token', v_token, 'group_id', p_group_id, 'expires_at', v_expiry, 'max_uses', v_uses
  );
END;
$$;

-- ── circle_invite_peek ────────────────────────────────────────────────────────
-- What the join page shows somebody who has not signed in, and may have no account.
--
-- Deliberately narrow. It answers "what am I being asked to join, and is this link still good" and
-- nothing else. No member names, no pot balance, no owner identity: the token proves somebody sent
-- you a link, which is not the same as being in the circle. Migration 093 made the same call about
-- resolve_profiles, where the column list IS the security boundary.
--
-- Always returns a row rather than raising, because a dead link is a page to render and not an error.
CREATE OR REPLACE FUNCTION public.circle_invite_peek(p_token text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  i       public.circle_invites%rowtype;
  g       public.esusu_groups%rowtype;
  v_count int;
  v_why   text;
BEGIN
  SELECT * INTO i FROM public.circle_invites WHERE token = p_token;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'unknown'); END IF;

  SELECT * INTO g FROM public.esusu_groups WHERE id = i.group_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'gone'); END IF;

  SELECT COUNT(*) INTO v_count FROM public.esusu_members
   WHERE group_id = i.group_id AND NOT COALESCE(removed, false);

  v_why := CASE
    WHEN i.revoked_at IS NOT NULL                THEN 'revoked'
    WHEN i.expires_at <= now()                   THEN 'expired'
    WHEN i.max_uses > 0 AND i.uses >= i.max_uses THEN 'used_up'
    WHEN g.status NOT IN ('forming', 'active')   THEN 'closed'
    WHEN v_count >= g.max_members                THEN 'full'
    ELSE NULL
  END;

  RETURN jsonb_build_object(
    'ok',                v_why IS NULL,
    'reason',            v_why,
    'name',              g.name,
    'circle_type',       g.circle_type,
    'payout_mode',       g.payout_mode,
    'purpose',           g.purpose,
    'member_count',      v_count,
    'max_members',       g.max_members,
    'contribution_kobo', g.contribution_amount_kobo,
    'cycle_period',      g.cycle_period,
    'goal_kobo',         g.goal_kobo,
    'deadline',          g.deadline
  );
END;
$$;

-- ── circle_invite_redeem ──────────────────────────────────────────────────────
-- Locks the invite row first, so two people opening the last use of a capped invite at the same
-- moment cannot both get in. The seat count itself is join_esusu_group's business, under its own
-- FOR UPDATE on the group.
--
-- `uses` counts successful joins only. An already-a-member attempt returns ok with joined=false and
-- does not burn a use: forwarding a link to somebody already in should not cost the circle a seat.
CREATE OR REPLACE FUNCTION public.circle_invite_redeem(
  p_token   text,
  p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  i      public.circle_invites%rowtype;
  v_peek jsonb;
  v_join jsonb;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'circle_invite_redeem: unauthorized';
  END IF;

  SELECT * INTO i FROM public.circle_invites WHERE token = p_token FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'unknown'); END IF;

  v_peek := public.circle_invite_peek(p_token);

  -- Membership is checked BEFORE the link's validity, because being in the circle is a fact about
  -- the user and not about the link. The common case is a member tapping the link they shared, and
  -- by then the circle is usually full or the link spent — so validity-first told them "this circle
  -- is full" when the true answer was "you are already in it".
  IF EXISTS (
    SELECT 1 FROM public.esusu_members
    WHERE group_id = i.group_id AND user_id = p_user_id AND NOT COALESCE(removed, false)
  ) THEN
    RETURN jsonb_build_object('ok', true, 'joined', false, 'reason', 'already_member',
                             'group_id', i.group_id, 'name', v_peek->>'name');
  END IF;

  -- One validity rule, in one place, re-checked here under the lock rather than trusted from
  -- whatever the join page rendered a minute ago.
  IF (v_peek->>'ok')::boolean IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', false, 'reason', v_peek->>'reason', 'name', v_peek->>'name');
  END IF;

  v_join := public.join_esusu_group(i.group_id, p_user_id);
  IF (v_join->>'ok')::boolean IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'join_failed',
                             'error', v_join->>'error', 'name', v_peek->>'name');
  END IF;

  UPDATE public.circle_invites SET uses = uses + 1 WHERE token = p_token;

  RETURN jsonb_build_object(
    'ok', true, 'joined', true, 'group_id', i.group_id, 'name', v_peek->>'name',
    'position', v_join->'position', 'is_full', v_join->'is_full'
  );
END;
$$;

-- ── circle_invite_revoke ──────────────────────────────────────────────────────
-- A link handed to the wrong person has to be cancellable, which is most of the point of tokens.
CREATE OR REPLACE FUNCTION public.circle_invite_revoke(
  p_token text,
  p_actor uuid
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_owner uuid;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_actor THEN
    RAISE EXCEPTION 'circle_invite_revoke: unauthorized';
  END IF;

  SELECT g.owner_id INTO v_owner
  FROM public.circle_invites i JOIN public.esusu_groups g ON g.id = i.group_id
  WHERE i.token = p_token;
  IF v_owner IS NULL THEN RETURN false; END IF;
  IF v_owner <> p_actor THEN
    RAISE EXCEPTION 'circle_invite_revoke: only the circle owner can revoke an invite';
  END IF;

  UPDATE public.circle_invites SET revoked_at = now()
  WHERE token = p_token AND revoked_at IS NULL;
  RETURN FOUND;
END;
$$;

-- ── grants ────────────────────────────────────────────────────────────────────
-- service_role only. The app reaches these through routes that derive the actor from the bearer,
-- which is the whole reason the p_actor / p_user_id parameters are safe to have at all.
REVOKE ALL ON FUNCTION public.circle_invite_create(uuid,uuid,text,int,int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.circle_invite_peek(text)                     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.circle_invite_redeem(text,uuid)              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.circle_invite_revoke(text,uuid)              FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.circle_invite_create(uuid,uuid,text,int,int) TO service_role;
GRANT EXECUTE ON FUNCTION public.circle_invite_peek(text)                     TO service_role;
GRANT EXECUTE ON FUNCTION public.circle_invite_redeem(text,uuid)              TO service_role;
GRANT EXECUTE ON FUNCTION public.circle_invite_revoke(text,uuid)              TO service_role;
