-- 119: Compliance monitoring, account holds and the admin compliance desk.
--
-- Account status (profiles.compliance_status):
--   clear   normal
--   review  money can come in and stay in the platform, but nothing leaves (withdrawals,
--           P2P sends, Pay with Pawa, new loans) until compliance clears it
--   frozen  as review, and investing is blocked too
-- Enforcement is in the API routes (lib/compliance.ts). Inflows are never blocked: a bank
-- transfer cannot be refused, and returning funds to an unknown sender is itself a risk.
--
-- compliance_scan() runs the monitoring rules over recent transactions and opens flags.
-- A HIGH flag puts the account on 'review' automatically. Only an admin clears it.
-- Thresholds live in platform_settings (compliance_*) so they can be tuned without a release.
--
-- Wording shown to users is deliberately neutral ("routine review"): telling a customer they
-- are suspected or reported is tipping-off, which the Money Laundering (Prevention and
-- Prohibition) Act 2022 prohibits.

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS compliance_status TEXT NOT NULL DEFAULT 'clear';
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS compliance_reason TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS compliance_updated_at TIMESTAMPTZ;
DO $$ BEGIN
  ALTER TABLE public.profiles ADD CONSTRAINT profiles_compliance_status_check
    CHECK (compliance_status IN ('clear', 'review', 'frozen'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A customer must never be able to clear their own hold: block any change to these columns
-- made under the 'authenticated' role (same pattern as protect_transaction_pin, migration 045).
CREATE OR REPLACE FUNCTION public.protect_compliance_status()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF (NEW.compliance_status IS DISTINCT FROM OLD.compliance_status
      OR NEW.compliance_reason IS DISTINCT FROM OLD.compliance_reason
      OR NEW.compliance_updated_at IS DISTINCT FROM OLD.compliance_updated_at)
     -- Same lookup as Supabase's auth.role(), inlined so the migration has no auth-schema dependency.
     AND COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''),
                  NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'authenticated' THEN
    RAISE EXCEPTION 'Compliance status can only be changed by PawaSave';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_protect_compliance_status ON public.profiles;
CREATE TRIGGER trg_protect_compliance_status
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.protect_compliance_status();

CREATE TABLE IF NOT EXISTS public.compliance_flags (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES public.profiles(id),
  rule        TEXT NOT NULL,
  severity    TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
  details     JSONB NOT NULL DEFAULT '{}'::jsonb,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dismissed', 'actioned')),
  day         DATE NOT NULL DEFAULT (now() AT TIME ZONE 'Africa/Lagos')::date,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT,
  note        TEXT
);
-- One flag per user, rule and day, so an hourly scan never piles up duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS compliance_flags_user_rule_day ON public.compliance_flags (user_id, rule, day);
CREATE INDEX IF NOT EXISTS compliance_flags_open ON public.compliance_flags (status, severity) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS public.compliance_actions (
  id         BIGSERIAL PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES public.profiles(id),
  action     TEXT NOT NULL CHECK (action IN ('review', 'freeze', 'clear', 'pin_reset', 'note', 'str_filed', 'ctr_filed', 'auto_review')),
  reason     TEXT,
  actor      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS compliance_actions_user ON public.compliance_actions (user_id, created_at DESC);

ALTER TABLE public.compliance_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compliance_actions ENABLE ROW LEVEL SECURITY;
-- No policies: only the service role (admin API, cron) reads or writes these tables.

INSERT INTO public.platform_settings (key, value) VALUES
  ('compliance_large_tx_kobo',         '100000000'),   -- ₦1,000,000 single transaction
  ('compliance_ctr_kobo',              '500000000'),   -- ₦5,000,000 a day: currency transaction report
  ('compliance_velocity_count',        '10'),          -- deposits or withdrawals in 24h
  ('compliance_passthrough_min_kobo',  '20000000'),    -- ₦200,000 in, mostly out again within 24h
  ('compliance_new_account_kobo',      '50000000'),    -- ₦500,000 into an account under 7 days old
  ('compliance_structuring_floor_kobo','1800000'),     -- deposits of ₦18,000–₦20,000 (just under the ₦20k tier)
  ('compliance_p2p_recipients',        '15')           -- distinct P2P recipients in 24h
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public._compliance_setting(p_key TEXT, p_default BIGINT)
RETURNS BIGINT LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT COALESCE((SELECT NULLIF(value, '')::bigint FROM platform_settings WHERE key = p_key), p_default);
$$;

CREATE OR REPLACE FUNCTION public._compliance_flag(p_user UUID, p_rule TEXT, p_severity TEXT, p_details JSONB)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_new BOOLEAN;
BEGIN
  INSERT INTO compliance_flags (user_id, rule, severity, details)
  VALUES (p_user, p_rule, p_severity, p_details)
  ON CONFLICT (user_id, rule, day) DO NOTHING;
  v_new := FOUND;
  -- A high-severity flag holds outflows until an admin clears the account.
  IF v_new AND p_severity = 'high' THEN
    UPDATE profiles
       SET compliance_status = 'review',
           compliance_reason = 'Automatic hold: ' || p_rule,
           compliance_updated_at = now()
     WHERE id = p_user AND compliance_status = 'clear';
    IF FOUND THEN
      INSERT INTO compliance_actions (user_id, action, reason, actor) VALUES (p_user, 'auto_review', p_rule, 'system');
    END IF;
  END IF;
  RETURN v_new;
END;
$$;

-- Runs every monitoring rule over the last 24 hours (7 days for account age). Returns how many
-- new flags it opened. Safe to run as often as you like.
CREATE OR REPLACE FUNCTION public.compliance_scan()
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r RECORD;
  n INTEGER := 0;
  v_large   BIGINT := _compliance_setting('compliance_large_tx_kobo', 100000000);
  v_ctr     BIGINT := _compliance_setting('compliance_ctr_kobo', 500000000);
  v_vel     BIGINT := _compliance_setting('compliance_velocity_count', 10);
  v_pass    BIGINT := _compliance_setting('compliance_passthrough_min_kobo', 20000000);
  v_newacct BIGINT := _compliance_setting('compliance_new_account_kobo', 50000000);
  v_struct  BIGINT := _compliance_setting('compliance_structuring_floor_kobo', 1800000);
  v_p2p     BIGINT := _compliance_setting('compliance_p2p_recipients', 15);
BEGIN
  -- Inflows: deposits and P2P/Pawa receipts. Outflows: withdrawals, P2P sends, Pawa payments.
  FOR r IN
    SELECT t.user_id,
           SUM(t.amount_kobo) FILTER (WHERE t.type IN ('deposit', 'transfer_in', 'pawa_receive')) AS in_kobo,
           SUM(t.amount_kobo) FILTER (WHERE t.type IN ('withdrawal', 'transfer_out', 'pawa_pay')) AS out_kobo,
           COUNT(*) FILTER (WHERE t.type = 'deposit') AS deposits,
           COUNT(*) FILTER (WHERE t.type = 'withdrawal') AS withdrawals,
           MAX(t.amount_kobo) FILTER (WHERE t.type IN ('deposit', 'withdrawal', 'transfer_in', 'transfer_out')) AS max_kobo,
           COUNT(*) FILTER (WHERE t.type = 'deposit' AND t.amount_kobo >= v_struct AND t.amount_kobo < 2000000) AS near_limit
      FROM transactions t
     WHERE t.created_at > now() - interval '24 hours'
       AND COALESCE(t.status, 'completed') NOT IN ('failed', 'cancelled', 'reverted')
     GROUP BY t.user_id
  LOOP
    IF COALESCE(r.max_kobo, 0) >= v_large THEN
      n := n + _compliance_flag(r.user_id, 'large_transaction', 'medium', jsonb_build_object('max_naira', r.max_kobo / 100))::int;
    END IF;
    IF COALESCE(r.in_kobo, 0) >= v_ctr OR COALESCE(r.out_kobo, 0) >= v_ctr THEN
      n := n + _compliance_flag(r.user_id, 'ctr_threshold', 'high', jsonb_build_object('in_naira', COALESCE(r.in_kobo, 0) / 100, 'out_naira', COALESCE(r.out_kobo, 0) / 100))::int;
    END IF;
    IF r.deposits >= v_vel OR r.withdrawals >= v_vel THEN
      n := n + _compliance_flag(r.user_id, 'velocity', 'medium', jsonb_build_object('deposits', r.deposits, 'withdrawals', r.withdrawals))::int;
    END IF;
    IF COALESCE(r.in_kobo, 0) >= v_pass AND COALESCE(r.out_kobo, 0) >= COALESCE(r.in_kobo, 0) * 0.8 THEN
      n := n + _compliance_flag(r.user_id, 'pass_through', 'high', jsonb_build_object('in_naira', r.in_kobo / 100, 'out_naira', r.out_kobo / 100))::int;
    END IF;
    IF r.near_limit >= 3 THEN
      n := n + _compliance_flag(r.user_id, 'structuring', 'high', jsonb_build_object('deposits_just_under_limit', r.near_limit))::int;
    END IF;
  END LOOP;

  -- Large inflows into a brand-new account.
  FOR r IN
    SELECT p.id AS user_id, SUM(t.amount_kobo) AS in_kobo
      FROM profiles p JOIN transactions t ON t.user_id = p.id
     WHERE p.created_at > now() - interval '7 days'
       AND t.type IN ('deposit', 'transfer_in', 'pawa_receive')
       AND COALESCE(t.status, 'completed') NOT IN ('failed', 'cancelled', 'reverted')
     GROUP BY p.id
    HAVING SUM(t.amount_kobo) >= v_newacct
  LOOP
    n := n + _compliance_flag(r.user_id, 'new_account_large_inflow', 'medium', jsonb_build_object('in_naira', r.in_kobo / 100))::int;
  END LOOP;

  -- Fan-out: one account paying many different people in a day.
  FOR r IN
    SELECT sender_id AS user_id, COUNT(DISTINCT COALESCE(recipient_id::text, recipient_email)) AS recipients
      FROM p2p_transfers
     WHERE created_at > now() - interval '24 hours'
     GROUP BY sender_id
    HAVING COUNT(DISTINCT COALESCE(recipient_id::text, recipient_email)) >= v_p2p
  LOOP
    n := n + _compliance_flag(r.user_id, 'p2p_fan_out', 'medium', jsonb_build_object('recipients', r.recipients))::int;
  END LOOP;

  -- Repeated PIN lockouts (possible account takeover attempts).
  FOR r IN
    SELECT id AS user_id, pin_failed_attempts FROM profiles
     WHERE pin_locked_until IS NOT NULL AND pin_locked_until > now() - interval '24 hours'
  LOOP
    n := n + _compliance_flag(r.user_id, 'pin_lockout', 'low', jsonb_build_object('failed_attempts', r.pin_failed_attempts))::int;
  END LOOP;

  RETURN n;
END;
$$;

-- Headline numbers for the admin compliance desk.
CREATE OR REPLACE FUNCTION public.compliance_metrics()
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'users_total',            (SELECT COUNT(*) FROM profiles),
    'users_kyc_verified',     (SELECT COUNT(*) FROM profiles WHERE kyc_status = 'verified'),
    'users_bvn_onboarded',    (SELECT COUNT(*) FROM profiles WHERE strails_va_account_number IS NOT NULL),
    'users_in_review',        (SELECT COUNT(*) FROM profiles WHERE compliance_status = 'review'),
    'users_frozen',           (SELECT COUNT(*) FROM profiles WHERE compliance_status = 'frozen'),
    'flags_open_high',        (SELECT COUNT(*) FROM compliance_flags WHERE status = 'open' AND severity = 'high'),
    'flags_open_medium',      (SELECT COUNT(*) FROM compliance_flags WHERE status = 'open' AND severity = 'medium'),
    'flags_open_low',         (SELECT COUNT(*) FROM compliance_flags WHERE status = 'open' AND severity = 'low'),
    'flags_7d',               (SELECT COUNT(*) FROM compliance_flags WHERE created_at > now() - interval '7 days'),
    'flags_dismissed_30d',    (SELECT COUNT(*) FROM compliance_flags WHERE status = 'dismissed' AND resolved_at > now() - interval '30 days'),
    'flags_actioned_30d',     (SELECT COUNT(*) FROM compliance_flags WHERE status = 'actioned' AND resolved_at > now() - interval '30 days'),
    'median_hours_to_resolve',(SELECT ROUND((EXTRACT(EPOCH FROM percentile_cont(0.5) WITHIN GROUP (ORDER BY resolved_at - created_at)) / 3600)::numeric, 1)
                                 FROM compliance_flags WHERE resolved_at > now() - interval '30 days'),
    'str_filed_30d',          (SELECT COUNT(*) FROM compliance_actions WHERE action = 'str_filed' AND created_at > now() - interval '30 days'),
    'ctr_filed_30d',          (SELECT COUNT(*) FROM compliance_actions WHERE action = 'ctr_filed' AND created_at > now() - interval '30 days'),
    'volume_30d_naira',       (SELECT COALESCE(SUM(amount_kobo), 0) / 100 FROM transactions
                                WHERE created_at > now() - interval '30 days' AND type IN ('deposit', 'withdrawal')),
    'volume_30d_verified_naira', (SELECT COALESCE(SUM(t.amount_kobo), 0) / 100 FROM transactions t JOIN profiles p ON p.id = t.user_id
                                WHERE t.created_at > now() - interval '30 days' AND t.type IN ('deposit', 'withdrawal')
                                  AND (p.kyc_status = 'verified' OR p.strails_va_account_number IS NOT NULL))
  );
$$;

REVOKE ALL ON FUNCTION public._compliance_setting(TEXT, BIGINT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._compliance_flag(UUID, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.compliance_scan() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.compliance_metrics() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.compliance_scan() TO service_role;
GRANT EXECUTE ON FUNCTION public.compliance_metrics() TO service_role;
