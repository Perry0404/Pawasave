-- ============================================================
-- Migration 027: One-off data re-denomination  USD → cNGN
--
-- The app used to store balances as USD micro-units and value them with the
-- NGN/USD rate. It now stores cNGN micro-units (1 cNGN = ₦1) with no rate.
-- This converts EXISTING balances by multiplying every USD micro field by the
-- NGN/USD rate in effect, so a $6 balance becomes ₦9,600 (= 9,600 cNGN).
--
-- ⚠️  RUN ONCE. It is guarded by a platform_settings flag so re-running is a
--     no-op. If you are pre-launch with only test data, you can skip this and
--     reset balances instead.
--
-- 1) EDIT v_rate below to the NGN/USD rate you want to lock existing balances at.
-- 2) Run the whole script in the Supabase  editor.
-- ============================================================

DO $$
DECLARE
  v_rate numeric := 1600;   -- <<< EDIT ME: NGN per USD used to convert old balances
  v_done text;
BEGIN
  SELECT value INTO v_done FROM public.platform_settings WHERE key = 'redenominated_to_cngn';
  IF v_done = 'true' THEN
    RAISE NOTICE 'Already re-denominated to cNGN — skipping.';
    RETURN;
  END IF;

  -- Wallet balances
  UPDATE public.wallets SET
    usdc_balance_micro      = floor(coalesce(usdc_balance_micro, 0)      * v_rate),
    cngn_pool_micro         = floor(coalesce(cngn_pool_micro, 0)         * v_rate),
    cngn_yield_earned_micro = floor(coalesce(cngn_yield_earned_micro, 0) * v_rate);

  -- Fixed-savings locks
  UPDATE public.savings_locks SET
    amount_usdc_micro            = floor(coalesce(amount_usdc_micro, 0)            * v_rate),
    projected_interest_micro     = floor(coalesce(projected_interest_micro, 0)     * v_rate);

  -- Savings goals
  UPDATE public.savings_goals SET
    target_usdc_micro       = floor(coalesce(target_usdc_micro, 0)       * v_rate),
    saved_usdc_micro        = floor(coalesce(saved_usdc_micro, 0)        * v_rate),
    contribution_usdc_micro = floor(coalesce(contribution_usdc_micro, 0) * v_rate),
    interest_earned_micro   = floor(coalesce(interest_earned_micro, 0)   * v_rate);

  -- Historical transaction USD amounts (display only)
  UPDATE public.transactions SET
    amount_usdc_micro = floor(coalesce(amount_usdc_micro, 0) * v_rate)
  WHERE amount_usdc_micro IS NOT NULL;

  -- Revenue journal (admin analytics)
  UPDATE public.revenue_journal SET
    amount_usdc_micro = floor(coalesce(amount_usdc_micro, 0) * v_rate);

  INSERT INTO public.platform_settings (key, value, description)
  VALUES ('redenominated_to_cngn', 'true',
          'Balances re-based from USD to cNGN (1 cNGN = ₦1) — see migration 027')
  ON CONFLICT (key) DO UPDATE SET value = 'true', updated_at = now();

  RAISE NOTICE 'Re-denominated balances to cNGN at rate %.', v_rate;
END $$;
