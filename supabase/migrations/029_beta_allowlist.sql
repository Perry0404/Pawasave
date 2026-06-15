-- 029_beta_allowlist.sql
-- Beta cohort gate: while beta_mode is 'on', only allowlisted emails can create
-- an account. Enforced inside the new-user trigger so it CANNOT be bypassed by
-- calling the Supabase client directly. Defaults to OFF — turning it on without
-- allowlisting yourself first would lock you out, so this migration changes
-- nothing until you (a) add emails and (b) flip beta_mode to 'on'.

-- ── 1. Allowlist table (service-role only via RLS-with-no-policies) ────────────
CREATE TABLE IF NOT EXISTS public.beta_allowlist (
  email    text PRIMARY KEY,
  note     text,
  added_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.beta_allowlist ENABLE ROW LEVEL SECURITY;
-- No policies → only the service role (which bypasses RLS) can read/write it.

-- ── 2. Beta-mode flag (reuse platform_settings; absent or != 'on' means off) ───
INSERT INTO public.platform_settings (key, value) VALUES ('beta_mode', 'off')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.is_beta_mode()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT COALESCE((SELECT value = 'on' FROM public.platform_settings WHERE key = 'beta_mode'), false);
$$;

-- True when signups are open to this email: either beta is off, or the email is
-- on the allowlist (case-insensitive).
CREATE OR REPLACE FUNCTION public.is_signup_allowed(p_email text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT (NOT public.is_beta_mode())
      OR EXISTS (SELECT 1 FROM public.beta_allowlist WHERE email = lower(p_email));
$$;

-- Keep these internal — the app reads them through the service-role API, not RPC.
REVOKE EXECUTE ON FUNCTION public.is_beta_mode()           FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.is_signup_allowed(text)  FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.is_beta_mode()           TO service_role;
GRANT  EXECUTE ON FUNCTION public.is_signup_allowed(text)  TO service_role;

-- ── 3. Enforce the gate in the new-user trigger (hard backstop) ───────────────
-- Mirrors 026_crypto_deposits.handle_new_user, with the allowlist check prepended.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  IF NOT public.is_signup_allowed(new.email) THEN
    RAISE EXCEPTION 'PAWASAVE_BETA_CLOSED: % is not on the beta allowlist', new.email
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.profiles (id, phone, display_name, transaction_pin_hash, pin_set_at)
  VALUES (
    new.id,
    new.phone,
    COALESCE(new.raw_user_meta_data->>'display_name', ''),
    NULLIF(new.raw_user_meta_data->>'transaction_pin_hash', ''),
    CASE WHEN NULLIF(new.raw_user_meta_data->>'transaction_pin_hash', '') IS NULL
         THEN NULL ELSE now() END
  );

  -- deposit_index is assigned by its DEFAULT sequence; deposit_address is
  -- derived + stored by the app from DEPOSIT_WALLET_MNEMONIC on first view.
  INSERT INTO public.wallets (user_id)
  VALUES (new.id)
  ON CONFLICT (user_id) DO NOTHING;

  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── How to run a closed beta ──────────────────────────────────────────────────
--   1. Add emails:   INSERT INTO public.beta_allowlist (email) VALUES (lower('you@x.com'));
--   2. Turn it on:   UPDATE public.platform_settings SET value='on' WHERE key='beta_mode';
--   3. Open to all:  UPDATE public.platform_settings SET value='off' WHERE key='beta_mode';
-- (Or manage all of this from the admin API: /api/admin/beta.)