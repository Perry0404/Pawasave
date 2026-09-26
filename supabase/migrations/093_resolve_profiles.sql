-- 093_resolve_profiles.sql
-- Let a signed-in user resolve a counterparty's public identity (spec: PAWA_2.0_REDESIGN §05, §06).
--
-- Why this is needed. `profiles` RLS is self-only: `USING (auth.uid() = id)` from 001. So a client
-- reading its own `p2p_transfers` rows gets the counterparty's UUID and cannot turn it into a name.
-- Every social surface in the redesign needs that: the activity feed says "You sent Sarah ₦5,000",
-- the person page is a relationship history, and recents are a list of people. Without this the feed
-- can only show UUIDs.
--
-- Why a function and not a view. `profiles` holds `phone`, `kyc_status`, the BVN hash and
-- `transaction_pin_hash`, so nothing may select it broadly. A view would have to bypass the table's
-- RLS to be useful, and views are an area week1 task 18 is actively tightening (`security_invoker`),
-- so adding one there invites confusion. A SECURITY DEFINER function with an explicit column list
-- matches how the other ~63 privileged reads in this schema already work, and the projection is
-- enforced by the function body rather than by a grant someone can widen later.
--
-- Disclosure this does create: given a profile id, the caller learns that id's tag and display name.
-- Ids are UUIDs and not guessable, and `/api/p2p/resolve` already maps the other direction
-- (tag -> identity) by design, so this adds no new class of exposure. The array cap below is there so
-- it cannot be used for bulk enumeration if an id list ever leaks.
--
-- Apply by hand, in filename order. Depends on 084 for `profiles.tag`.

-- ── pin search_path on migration 092's functions ─────────────────────────────
-- 092 created three SECURITY DEFINER functions without pinning search_path, which added to the
-- 79 production functions week1 already flagged. A definer function without a pinned path resolves
-- unqualified names using the CALLER's search_path, so a caller who can create objects in an earlier
-- schema can shadow a table it relies on. ALTER attaches the setting without touching the body.
-- `pg_temp` goes last so a temporary object cannot shadow anything.
ALTER FUNCTION public.push_device_register(UUID, TEXT, TEXT, TEXT) SET search_path = public, pg_temp;
ALTER FUNCTION public.push_device_forget(UUID, TEXT)               SET search_path = public, pg_temp;
ALTER FUNCTION public.push_device_mark_dead(TEXT)                  SET search_path = public, pg_temp;

-- ── resolve a batch of public identities ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.resolve_profiles(p_ids UUID[])
RETURNS TABLE (id UUID, tag TEXT, display_name TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Callable only by a signed-in user. Anonymous callers have no legitimate need and would make
  -- this a directory.
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'resolve_profiles: authentication required';
  END IF;

  IF p_ids IS NULL OR array_length(p_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  -- One screen of activity resolves a few dozen counterparties at most. The cap makes bulk
  -- enumeration impossible rather than merely slow.
  IF array_length(p_ids, 1) > 200 THEN
    RAISE EXCEPTION 'resolve_profiles: at most 200 ids per call';
  END IF;

  -- The column list IS the security boundary. Never add phone, kyc_status, kyc_tier, the BVN hash,
  -- transaction_pin_hash or any Strails field here.
  RETURN QUERY
  SELECT p.id, p.tag, p.display_name
  FROM public.profiles p
  WHERE p.id = ANY(p_ids);
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_profiles(UUID[]) FROM PUBLIC, anon;
-- Granted to `authenticated` on purpose: this is a client-side read, consistent with balance and
-- activity being read directly under RLS. service_role gets it for server-side rendering paths.
GRANT EXECUTE ON FUNCTION public.resolve_profiles(UUID[]) TO authenticated, service_role;
