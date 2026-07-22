-- 041_strails_accounts.sql
-- Strails (Stablesrail) integration: permanent per-user Naira virtual accounts.
--
-- After a user verifies (Sense liveness) AND provides their BVN, we onboard them to
-- Strails, which validates the BVN and issues a PERMANENT dedicated NUBAN. Money sent
-- to that account auto-mints cNGN. This adds the columns that flow records.
--
-- BVN is sensitive PII: we send it to Strails once and DO NOT persist the raw value.
-- We keep only a salted hash (bvn_hash) for dedup / "already onboarded?" checks.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS strails_user_id            text,
  ADD COLUMN IF NOT EXISTS strails_onboard_request_id text,
  ADD COLUMN IF NOT EXISTS strails_onboard_status     text,   -- processing | completed | failed
  ADD COLUMN IF NOT EXISTS strails_va_account_number  text,
  ADD COLUMN IF NOT EXISTS strails_va_account_name    text,
  ADD COLUMN IF NOT EXISTS strails_va_bank_name       text,
  ADD COLUMN IF NOT EXISTS bvn_hash                   text,
  ADD COLUMN IF NOT EXISTS strails_onboarded_at       timestamptz;

CREATE INDEX IF NOT EXISTS idx_profiles_strails_user  ON public.profiles (strails_user_id);
CREATE INDEX IF NOT EXISTS idx_profiles_strails_reqid ON public.profiles (strails_onboard_request_id);

-- Record the start of onboarding (called server-side after the Strails onboarduser
-- call succeeds). Service-role/SECURITY DEFINER; never stores the raw BVN.
CREATE OR REPLACE FUNCTION public.set_strails_onboarding(
  p_user_id     uuid,
  p_request_id  text,
  p_strails_uid text,
  p_status      text,
  p_bvn_hash    text
) RETURNS void AS $$
BEGIN
  UPDATE public.profiles
  SET strails_onboard_request_id = COALESCE(p_request_id, strails_onboard_request_id),
      strails_user_id            = COALESCE(p_strails_uid, strails_user_id),
      strails_onboard_status     = COALESCE(p_status, strails_onboard_status),
      bvn_hash                   = COALESCE(p_bvn_hash, bvn_hash)
  WHERE id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Record the issued permanent virtual account (called from the Strails webhook on
-- user.onboarded). Marks onboarding completed.
CREATE OR REPLACE FUNCTION public.set_strails_account(
  p_user_id     uuid,
  p_strails_uid text,
  p_acct_number text,
  p_acct_name   text,
  p_bank_name   text
) RETURNS void AS $$
BEGIN
  UPDATE public.profiles
  SET strails_user_id           = COALESCE(p_strails_uid, strails_user_id),
      strails_va_account_number = COALESCE(p_acct_number, strails_va_account_number),
      strails_va_account_name   = COALESCE(p_acct_name, strails_va_account_name),
      strails_va_bank_name      = COALESCE(p_bank_name, strails_va_bank_name),
      strails_onboard_status    = 'completed',
      strails_onboarded_at      = COALESCE(strails_onboarded_at, now())
  WHERE id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.set_strails_onboarding(uuid, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_strails_account(uuid, text, text, text, text) TO service_role;