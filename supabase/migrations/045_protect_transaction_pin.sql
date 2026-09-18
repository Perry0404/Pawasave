-- 045_protect_transaction_pin.sql
-- Item 5 (security): the transaction PIN could be changed by any authenticated
-- session via a direct client-side UPDATE of profiles.transaction_pin_hash, with NO
-- verification of the current PIN. A stolen session could reset the PIN and then
-- authorise withdrawals/loans.
--
-- This trigger blocks any change to transaction_pin_hash made under the 'authenticated'
-- role, forcing all PIN changes through /api/security/pin, which runs as the service
-- role and verifies the current PIN first. (Legitimate service-role writes and signup
-- inserts are unaffected.)

CREATE OR REPLACE FUNCTION public.protect_transaction_pin()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NEW.transaction_pin_hash IS DISTINCT FROM OLD.transaction_pin_hash
     AND COALESCE(auth.role(), '') = 'authenticated' THEN
    RAISE EXCEPTION 'Transaction PIN can only be changed through the secure PIN endpoint';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_transaction_pin ON public.profiles;
CREATE TRIGGER trg_protect_transaction_pin
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.protect_transaction_pin();