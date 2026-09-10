-- 033_kyc_sense.sql
-- Real KYC via Sense (usesense.ai) — biometric liveness + human-presence.
--
-- Before this, submit_kyc() set kyc_status = 'verified' unconditionally (a demo
-- stub with NO real check), and 005 even auto-verified pending profiles after a
-- minute. This migration:
--   1. Adds the columns the real flow writes (provider, session, decision, name/DOB).
--   2. Rewrites submit_kyc() to set 'submitted' (pending), never 'verified'. Only
--      the Sense webhook (server, service-role) may move a user to verified/rejected.
-- Existing 'verified' users are left as-is.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS kyc_provider    text,
  ADD COLUMN IF NOT EXISTS kyc_session_id  text,
  ADD COLUMN IF NOT EXISTS kyc_identity_id text,
  ADD COLUMN IF NOT EXISTS kyc_decision    text,
  ADD COLUMN IF NOT EXISTS kyc_reason      text,
  ADD COLUMN IF NOT EXISTS kyc_first_name  text,
  ADD COLUMN IF NOT EXISTS kyc_last_name   text,
  ADD COLUMN IF NOT EXISTS kyc_dob         date;

CREATE INDEX IF NOT EXISTS idx_profiles_kyc_session ON public.profiles (kyc_session_id);

-- Backward-compatible: keep the 3-arg signature, but NEVER auto-verify. It now
-- only records the submission as 'submitted' (pending the Sense verdict).
CREATE OR REPLACE FUNCTION public.submit_kyc(
  p_user_id uuid,
  p_kyc_type text,
  p_kyc_id_hash text
) RETURNS void AS $$
BEGIN
  UPDATE public.profiles
  SET kyc_status = CASE WHEN kyc_status = 'verified' THEN 'verified' ELSE 'submitted' END,
      kyc_type = p_kyc_type,
      kyc_id_hash = p_kyc_id_hash,
      kyc_submitted_at = now()
  WHERE id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Finalize a KYC decision from the Sense webhook. Service-role only (the webhook
-- uses the service key, which bypasses RLS). Restricts status to the valid set.
CREATE OR REPLACE FUNCTION public.finalize_kyc(
  p_user_id uuid,
  p_status text,
  p_provider text,
  p_session_id text,
  p_identity_id text,
  p_decision text,
  p_reason text
) RETURNS void AS $$
BEGIN
  IF p_status NOT IN ('verified', 'rejected', 'submitted') THEN
    RAISE EXCEPTION 'invalid kyc status %', p_status;
  END IF;

  UPDATE public.profiles
  SET kyc_status      = p_status,
      kyc_provider    = COALESCE(p_provider, kyc_provider),
      kyc_session_id  = COALESCE(p_session_id, kyc_session_id),
      kyc_identity_id = COALESCE(p_identity_id, kyc_identity_id),
      kyc_decision    = COALESCE(p_decision, kyc_decision),
      kyc_reason      = p_reason,
      kyc_verified_at = CASE WHEN p_status = 'verified' THEN now() ELSE kyc_verified_at END
  WHERE id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;