-- 084_p2p_tags.sql
-- PawaSave @tags — the human handle for peer-to-peer payments.
--
-- Sending to another PawaSave user is by @tag (people know a friend's tag, not their signup
-- email); email stays for reaching someone who isn't on PawaSave yet (the claim flow in 083).
-- Every account gets a unique tag automatically (so everyone is instantly payable) and can
-- change it. Tags are stored lower-case, matched case-insensitively, [a-z0-9_], 3–20 chars.
--
-- Writes go through set_user_tag (SECURITY DEFINER) — the browser can't write profiles (080).

-- ── column + shape ───────────────────────────────────────────────────────────
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS tag TEXT;
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_tag_format;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_tag_format
  CHECK (tag IS NULL OR tag ~ '^[a-z0-9_]{3,20}$');
CREATE UNIQUE INDEX IF NOT EXISTS profiles_tag_uniq ON public.profiles (lower(tag)) WHERE tag IS NOT NULL;

-- ── generate a unique tag from a seed (name / email local part) ───────────────
CREATE OR REPLACE FUNCTION public.gen_unique_tag(p_seed TEXT)
RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
  base      TEXT;
  candidate TEXT;
  n         INT := 0;
BEGIN
  base := regexp_replace(lower(coalesce(p_seed, '')), '[^a-z0-9_]', '', 'g');
  base := left(base, 15);
  IF length(base) < 3 THEN base := 'pawa'; END IF;

  candidate := base;
  LOOP
    -- A random suffix after the first collision keeps tags from being trivially enumerable.
    IF n > 0 THEN
      candidate := left(base, 12) || (100 + floor(random() * 9900))::INT::TEXT;
    END IF;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.profiles WHERE lower(tag) = lower(candidate));
    n := n + 1;
    IF n > 60 THEN  -- pathological fallback; effectively never hit
      candidate := 'pawa' || floor(random() * 1e9)::BIGINT::TEXT;
      EXIT;
    END IF;
  END LOOP;
  RETURN candidate;
END;
$$;

-- ── backfill every existing account, one row at a time ────────────────────────
-- Row-by-row (not a single UPDATE) so each gen_unique_tag call sees the tags assigned to
-- earlier rows in this same transaction and can't hand out a duplicate.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT id, display_name FROM public.profiles WHERE tag IS NULL LOOP
    UPDATE public.profiles
      SET tag = public.gen_unique_tag(coalesce(nullif(r.display_name, ''), 'pawa'))
      WHERE id = r.id;
  END LOOP;
END $$;

-- ── assign a tag to every NEW signup ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, phone, display_name, tag)
  VALUES (
    new.id,
    new.phone,
    coalesce(new.raw_user_meta_data->>'display_name', ''),
    public.gen_unique_tag(coalesce(
      nullif(new.raw_user_meta_data->>'display_name', ''),
      nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
      'pawa'))
  );
  INSERT INTO public.wallets (user_id) VALUES (new.id);
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── set / change a user's tag (validated, unique) ────────────────────────────
CREATE OR REPLACE FUNCTION public.set_user_tag(p_user_id UUID, p_tag TEXT)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_tag TEXT;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'set_user_tag: unauthorized';
  END IF;
  v_tag := ltrim(lower(trim(coalesce(p_tag, ''))), '@');
  IF v_tag !~ '^[a-z0-9_]{3,20}$' THEN
    RAISE EXCEPTION 'invalid_tag';   -- 3–20 chars, letters/numbers/underscore
  END IF;
  IF EXISTS (SELECT 1 FROM public.profiles WHERE lower(tag) = v_tag AND id <> p_user_id) THEN
    RAISE EXCEPTION 'tag_taken';
  END IF;
  UPDATE public.profiles SET tag = v_tag WHERE id = p_user_id;
  RETURN v_tag;
END;
$$;
REVOKE ALL ON FUNCTION public.set_user_tag(UUID,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_user_tag(UUID,TEXT) TO service_role;
