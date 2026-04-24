-- ============================================================
-- Migration 007: Security Hardening + Revenue Tracking
--
-- Fixes:
--   1. submit_kyc only allows auth.uid() = p_user_id
--   2. admin functions are no longer email-gated; they are
--      restricted to service_role-only execution so the admin UI
--      can stay password-based through Next.js server routes
--   3. record_platform_fee increments platform_revenue_kobo
--   4. transactions store platform_fee_kobo for net crediting
-- ============================================================

INSERT INTO public.platform_settings (key, value, description)
VALUES ('platform_revenue_kobo', '0', 'Accumulated platform fee revenue in kobo (withdrawable)')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS platform_fee_kobo bigint NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.submit_kyc(
  p_user_id uuid,
  p_kyc_type text,
  p_kyc_id_hash text
) RETURNS void AS $$
BEGIN
  IF auth.uid() IS NULL OR auth.uid() != p_user_id THEN
    RAISE EXCEPTION 'Unauthorized: you can only submit KYC for your own account';
  END IF;

  IF p_kyc_type NOT IN ('bvn', 'nin') THEN
    RAISE EXCEPTION 'Invalid kyc_type: must be bvn or nin';
  END IF;

  -- Keep demo behavior for now: auto-verify immediately.
  UPDATE public.profiles
  SET kyc_status       = 'verified',
      kyc_type         = p_kyc_type,
      kyc_id_hash      = p_kyc_id_hash,
      kyc_submitted_at = now(),
      kyc_verified_at  = now()
  WHERE id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.admin_verify_kyc(
  p_user_id uuid,
  p_approve boolean
) RETURNS void AS $$
BEGIN
  UPDATE public.profiles
  SET kyc_status      = CASE WHEN p_approve THEN 'verified' ELSE 'rejected' END,
      kyc_verified_at = CASE WHEN p_approve THEN now() ELSE NULL END
  WHERE id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.record_platform_fee(
  p_user_id uuid,
  p_reference text,
  p_fee_type text,
  p_gross_kobo bigint,
  p_fee_kobo bigint,
  p_fee_percent numeric
) RETURNS void AS $$
BEGIN
  INSERT INTO public.platform_fees (user_id, transaction_ref, fee_type, gross_amount_kobo, fee_amount_kobo, fee_percent)
  VALUES (p_user_id, p_reference, p_fee_type, p_gross_kobo, p_fee_kobo, p_fee_percent);

  UPDATE public.platform_settings
  SET value = (COALESCE(value::bigint, 0) + p_fee_kobo)::text
  WHERE key = 'platform_revenue_kobo';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.admin_fee_summary()
RETURNS TABLE (
  total_fees_kobo bigint,
  total_onramp_fees bigint,
  total_offramp_fees bigint,
  total_penalty_fees bigint,
  fee_count bigint,
  today_fees_kobo bigint,
  this_month_fees_kobo bigint
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    COALESCE(SUM(fee_amount_kobo), 0),
    COALESCE(SUM(CASE WHEN fee_type = 'ramp_onramp'        THEN fee_amount_kobo ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN fee_type = 'ramp_offramp'       THEN fee_amount_kobo ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN fee_type = 'vault_lock_penalty' THEN fee_amount_kobo ELSE 0 END), 0),
    COUNT(*)::bigint,
    COALESCE(SUM(CASE WHEN created_at::date = current_date THEN fee_amount_kobo ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN date_trunc('month', created_at) = date_trunc('month', current_date) THEN fee_amount_kobo ELSE 0 END), 0)
  FROM public.platform_fees;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.admin_user_stats()
RETURNS TABLE (
  total_users bigint,
  total_wallets bigint,
  total_naira_kobo bigint,
  total_usdc_micro bigint,
  total_locked_usdc_micro bigint,
  active_locks bigint
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    (SELECT COUNT(*) FROM public.profiles)::bigint,
    (SELECT COUNT(*) FROM public.wallets)::bigint,
    COALESCE((SELECT SUM(naira_balance_kobo) FROM public.wallets), 0),
    COALESCE((SELECT SUM(usdc_balance_micro) FROM public.wallets), 0),
    COALESCE((SELECT SUM(amount_usdc_micro) FROM public.savings_locks WHERE status = 'active'), 0),
    (SELECT COUNT(*) FROM public.savings_locks WHERE status = 'active')::bigint;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.admin_tx_volume()
RETURNS TABLE (
  total_deposits_kobo bigint,
  total_withdrawals_kobo bigint,
  total_vault_saves_kobo bigint,
  total_tx_count bigint,
  pending_count bigint
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    COALESCE(SUM(CASE WHEN type = 'deposit'       AND status = 'completed' THEN amount_kobo ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN type = 'withdrawal'    AND status = 'completed' THEN amount_kobo ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN type = 'save_to_vault' AND status = 'completed' THEN amount_kobo ELSE 0 END), 0),
    COUNT(*)::bigint,
    (SELECT COUNT(*) FROM public.transactions WHERE status = 'pending')::bigint
  FROM public.transactions;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.admin_recent_fees(p_limit int DEFAULT 50)
RETURNS TABLE (
  id uuid,
  user_id uuid,
  transaction_ref text,
  fee_type text,
  gross_amount_kobo bigint,
  fee_amount_kobo bigint,
  fee_percent numeric,
  created_at timestamptz
) AS $$
BEGIN
  p_limit := LEAST(GREATEST(p_limit, 1), 200);

  RETURN QUERY
  SELECT f.id, f.user_id, f.transaction_ref, f.fee_type,
         f.gross_amount_kobo, f.fee_amount_kobo, f.fee_percent, f.created_at
  FROM public.platform_fees f
  ORDER BY f.created_at DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.admin_deduct_revenue(p_amount_kobo bigint)
RETURNS void AS $$
DECLARE
  v_current bigint;
BEGIN
  SELECT value::bigint INTO v_current
  FROM public.platform_settings
  WHERE key = 'platform_revenue_kobo';

  IF COALESCE(v_current, 0) < p_amount_kobo THEN
    RAISE EXCEPTION 'Insufficient revenue balance';
  END IF;

  UPDATE public.platform_settings
  SET value = (v_current - p_amount_kobo)::text
  WHERE key = 'platform_revenue_kobo';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION public.admin_verify_kyc(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_fee_summary() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_user_stats() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_tx_volume() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_recent_fees(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_deduct_revenue(bigint) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.admin_verify_kyc(uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_fee_summary() TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_user_stats() TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_tx_volume() TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_recent_fees(int) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_deduct_revenue(bigint) TO service_role;
