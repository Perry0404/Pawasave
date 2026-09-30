-- 111_resolve_contacts.sql
-- Lets a signed-in user find out which of their phone contacts are on PawaSave (spec: send-flow
-- revamp, "Sync your contacts").
--
-- Same posture as 093's resolve_profiles: a SECURITY DEFINER function with an explicit column
-- list is the security boundary, not a grant on the table. `profiles.phone` is already stored in
-- cleartext (001, populated from auth.users.phone at signup) and already read elsewhere for
-- admin/SMS purposes (074), so this does not introduce a new class of exposure for the column
-- itself — it introduces a new *lookup direction* (phone -> identity), which is why the response
-- is capped to {phone, tag, display_name} and never echoes anything for a phone that has no match.
--
-- What this does NOT do: it does not store the caller's contact list anywhere. The phone numbers
-- in p_phones exist only for the duration of this call.
--
-- Apply by hand, in filename order. Depends on 001 for profiles.phone, 084 for profiles.tag.

CREATE OR REPLACE FUNCTION public.resolve_contacts(p_phones TEXT[])
RETURNS TABLE (phone TEXT, tag TEXT, display_name TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'resolve_contacts: authentication required';
  END IF;

  IF p_phones IS NULL OR array_length(p_phones, 1) IS NULL THEN
    RETURN;
  END IF;

  -- A device address book can run into the thousands. The cap keeps a single call cheap and,
  -- same as resolve_profiles, makes bulk enumeration impractical rather than merely slow — a
  -- phone number is guessable in a way a UUID is not, so this matters more here than there.
  IF array_length(p_phones, 1) > 500 THEN
    RAISE EXCEPTION 'resolve_contacts: at most 500 phones per call';
  END IF;

  -- The column list IS the security boundary. Never add id, email, kyc_status, kyc_tier, the BVN
  -- hash, transaction_pin_hash or any Strails field here. Matching a phone number back to the row
  -- that has no PawaSave account should be impossible from this function's output alone, since it
  -- only returns rows that matched.
  RETURN QUERY
  SELECT p.phone, p.tag, p.display_name
  FROM public.profiles p
  WHERE p.phone = ANY(p_phones)
    AND p.id <> auth.uid();
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_contacts(TEXT[]) FROM PUBLIC, anon;
-- authenticated, not just service_role: this is a client-side read under the caller's own
-- session, the same posture as resolve_profiles. service_role covers any future server-side path.
GRANT EXECUTE ON FUNCTION public.resolve_contacts(TEXT[]) TO authenticated, service_role;
