-- ============================================================
-- Migration 005: KYC, cNGN Yield Pool, Crypto Esusu Deposits
-- Run this ENTIRE script in Supabase SQL Editor
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- PART A: KYC fields on profiles
-- ────────────────────────────────────────────────────────────

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS kyc_status text NOT NULL DEFAULT 'pending'
    CHECK (kyc_status IN ('pending', 'submitted', 'verified', 'rejected')),
  ADD COLUMN IF NOT EXISTS kyc_type text CHECK (kyc_type IN ('bvn', 'nin')),
  ADD COLUMN IF NOT EXISTS kyc_id_hash text,
  ADD COLUMN IF NOT EXISTS kyc_submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS kyc_verified_at timestamptz;

-- ────────────────────────────────────────────────────────────
-- PART B: cNGN Pool balance on wallets
-- ────────────────────────────────────────────────────────────

ALTER TABLE public.wallets
  ADD COLUMN IF NOT EXISTS cngn_pool_micro bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cngn_yield_earned_micro bigint NOT NULL DEFAULT 0;

-- ────────────────────────────────────────────────────────────
-- PART C: Esusu Crypto Deposits table
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.esusu_crypto_deposits (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id uuid NOT NULL REFERENCES public.esusu_groups(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES public.esusu_members(id),
  user_id uuid NOT NULL REFERENCES public.profiles(id),
  wallet_address text NOT NULL,
  amount_cngn_micro bigint NOT NULL,
  tx_hash text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.esusu_crypto_deposits ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own crypto deposits" ON public.esusu_crypto_deposits
  FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "Users insert own crypto deposits" ON public.esusu_crypto_deposits
  FOR INSERT WITH CHECK (user_id = auth.uid());

-- ────────────────────────────────────────────────────────────
-- PART D: Update transaction type constraint for new types
-- ────────────────────────────────────────────────────────────

ALTER TABLE public.transactions
  DROP CONSTRAINT IF EXISTS transactions_type_check;

ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_type_check CHECK (type IN (
    'deposit', 'withdrawal', 'save_to_vault', 'vault_withdraw',
    'esusu_contribute', 'esusu_payout', 'emergency_payout',
    'split_auto_save', 'split_auto_esusu',
    'cngn_pool_in', 'cngn_pool_out', 'esusu_crypto_deposit'
  ));

-- ────────────────────────────────────────────────────────────
-- PART E: New platform settings
-- ────────────────────────────────────────────────────────────

INSERT INTO public.platform_settings (key, value, description) VALUES
  ('deposit_wallet_address', '', 'Base L2 wallet address for receiving crypto deposits'),
  ('cngn_pool_apy_percent', '8.0', 'cNGN yield pool APY (%)'),
  ('kyc_required', 'true', 'Whether KYC is required to use the platform')
ON CONFLICT (key) DO NOTHING;

-- ────────────────────────────────────────────────────────────
-- PART F: KYC submission function (auto-verify for demo)
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.submit_kyc(
  p_user_id uuid,
  p_kyc_type text,
  p_kyc_id_hash text
) RETURNS void AS $$
BEGIN
  UPDATE public.profiles
  SET kyc_status = 'verified',
      kyc_type = p_kyc_type,
      kyc_id_hash = p_kyc_id_hash,
      kyc_submitted_at = now(),
      kyc_verified_at = now()
  WHERE id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ────────────────────────────────────────────────────────────
-- PART G: Admin KYC management (for future use)
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.admin_verify_kyc(
  p_user_id uuid,
  p_approve boolean
) RETURNS void AS $$
BEGIN
  UPDATE public.profiles
  SET kyc_status = CASE WHEN p_approve THEN 'verified' ELSE 'rejected' END,
      kyc_verified_at = CASE WHEN p_approve THEN now() ELSE NULL END
  WHERE id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ────────────────────────────────────────────────────────────
-- PART H: cNGN Pool allocation (90% of deposits)
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.allocate_cngn_pool(
  p_user_id uuid,
  p_usdc_micro bigint
) RETURNS void AS $$
DECLARE
  v_cngn_portion bigint;
BEGIN
  v_cngn_portion := floor(p_usdc_micro * 0.90);

  UPDATE public.wallets
  SET cngn_pool_micro = cngn_pool_micro + v_cngn_portion,
      usdc_balance_micro = usdc_balance_micro - v_cngn_portion,
      updated_at = now()
  WHERE user_id = p_user_id
    AND usdc_balance_micro >= v_cngn_portion;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ────────────────────────────────────────────────────────────
-- PART I: Withdraw from cNGN pool
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.withdraw_cngn_pool(
  p_user_id uuid,
  p_amount_micro bigint
) RETURNS boolean AS $$
DECLARE
  w public.wallets%rowtype;
BEGIN
  SELECT * INTO w FROM public.wallets WHERE user_id = p_user_id FOR UPDATE;

  IF w.cngn_pool_micro < p_amount_micro THEN
    RETURN false;
  END IF;

  UPDATE public.wallets
  SET cngn_pool_micro = cngn_pool_micro - p_amount_micro,
      usdc_balance_micro = usdc_balance_micro + p_amount_micro,
      updated_at = now()
  WHERE user_id = p_user_id;

  RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ────────────────────────────────────────────────────────────
-- PART J: Esusu crypto contribution function
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.esusu_contribute_crypto(
  p_user_id uuid,
  p_group_id uuid,
  p_member_id uuid,
  p_amount_cngn_micro bigint,
  p_cycle int,
  p_wallet_address text
) RETURNS uuid AS $$
DECLARE
  v_amount_kobo bigint;
  v_deposit_id uuid;
BEGIN
  -- Convert cNGN micro to kobo (1 cNGN = 1 NGN; micro/1e6 * 100 = micro/10000)
  v_amount_kobo := floor(p_amount_cngn_micro / 10000);

  -- Record crypto deposit
  INSERT INTO public.esusu_crypto_deposits (
    group_id, member_id, user_id, wallet_address, amount_cngn_micro, status
  ) VALUES (
    p_group_id, p_member_id, p_user_id, p_wallet_address, p_amount_cngn_micro, 'confirmed'
  ) RETURNING id INTO v_deposit_id;

  -- Credit group pot (5% to emergency)
  UPDATE public.esusu_groups
  SET pot_balance_kobo = pot_balance_kobo + (v_amount_kobo * 95 / 100),
      emergency_pot_kobo = emergency_pot_kobo + (v_amount_kobo * 5 / 100)
  WHERE id = p_group_id;

  -- Record contribution
  INSERT INTO public.esusu_contributions (group_id, member_id, cycle_number, amount_kobo)
  VALUES (p_group_id, p_member_id, p_cycle, v_amount_kobo);

  RETURN v_deposit_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ────────────────────────────────────────────────────────────
-- PART K: Auto-verify existing users for smooth transition
-- ────────────────────────────────────────────────────────────

-- Existing users who registered before KYC was added get auto-verified
UPDATE public.profiles
SET kyc_status = 'verified', kyc_verified_at = now()
WHERE kyc_status = 'pending'
  AND created_at < now() - interval '1 minute';
