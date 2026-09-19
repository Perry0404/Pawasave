-- 089_morpho_loan_draws.sql
-- Phase 2 of Morpho-backed liquidity ([[morpho-borrow-liquidity]] / lib/morpho.ts):
-- track, per loan, the cNGN liquidity custody drew from Morpho to BACK that loan's
-- disbursement (post the pledged stock as collateral → borrow USDC → HyperFX → cNGN).
--
-- This is TREASURY metadata, not user money. The user's loan (create_loan / repay_loan,
-- migration 042) is unchanged and fully synchronous; the Morpho draw happens in the
-- background after disbursement and is reconciled/unwound by a cron. If Morpho is off
-- or a draw fails, the loan is unaffected — custody's existing float backs it, exactly
-- as it does today. So this table only ever RECORDS what the treasury did on-chain.
--
-- Aggregate model: all users' AAPL etc. sit in ONE custody wallet, so custody's Morpho
-- position per market is aggregate. We account each loan's contribution here (how much
-- collateral it added + USDC it borrowed) so repayment/liquidation can withdraw/repay
-- exactly that loan's share without touching other loans' positions.

CREATE TABLE IF NOT EXISTS public.morpho_loan_draws (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  loan_id      uuid NOT NULL UNIQUE REFERENCES public.loans(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL,
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','funded','settling','failed','closed')),
  -- Per-market legs: [{symbol, collateral_base, usdc_micro, supply_tx, borrow_tx}]
  legs         jsonb NOT NULL DEFAULT '[]'::jsonb,
  usdc_micro   bigint NOT NULL DEFAULT 0,   -- total USDC borrowed on Morpho for this loan
  cngn_micro   bigint NOT NULL DEFAULT 0,   -- cNGN received from HyperFX at funding (0 while 'settling')
  cngn_repaid_micro   bigint NOT NULL DEFAULT 0,  -- cNGN spent to unwind (buy back USDC + repay)
  -- All-in cost of this loan's Morpho financing, in cNGN micro:
  --   cngn_repaid_micro − cngn_micro  (= Morpho borrow interest + HyperFX round-trip spread).
  -- Booked AGAINST platform_revenue_kobo at unwind so net profit isn't overstated.
  financing_cost_micro bigint NOT NULL DEFAULT 0,
  repay_tx     text,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_morpho_draws_status ON public.morpho_loan_draws (status);

-- Treasury-only: no client ever reads or writes this. RLS on + zero policies = only the
-- service role (which bypasses RLS) can touch it.
ALTER TABLE public.morpho_loan_draws ENABLE ROW LEVEL SECURITY;

-- Config knobs (basis points unless noted).
INSERT INTO public.platform_settings (key, value) VALUES
  -- Borrow at most this % of a pledged holding's value from Morpho. Kept at the user
  -- equity LTV (40%) so we never draw more than we lent, leaving a big buffer under
  -- Morpho's own LLTV (~77%) → custody is far from Morpho liquidation.
  ('morpho_target_ltv_bps', '4000'),
  -- Warn (in the reconcile cron) if custody's utilisation in a market climbs past this
  -- fraction of Morpho's LLTV, so we can unwind before Morpho liquidates.
  ('morpho_health_warn_bps', '7500')
ON CONFLICT (key) DO NOTHING;

-- ── record_morpho_unwind ─────────────────────────────────────────────────────
-- Close a draw AND book its financing cost against net revenue, atomically. Revenue
-- from a Morpho-backed loan is: user interest + origination fee (already added to
-- platform_revenue_kobo by create_loan/repay_loan, migration 042) MINUS this cost, so
-- decrementing here makes platform_revenue_kobo the TRUE net. Service-role only; called
-- by the treasury unwind (lib/morpho-treasury.ts) after the on-chain repay settles.
CREATE OR REPLACE FUNCTION public.record_morpho_unwind(
  p_loan_id uuid, p_cngn_repaid_micro bigint, p_financing_cost_micro bigint, p_repay_tx text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE public.morpho_loan_draws
     SET status = 'closed',
         cngn_repaid_micro = GREATEST(0, COALESCE(p_cngn_repaid_micro, 0)),
         financing_cost_micro = COALESCE(p_financing_cost_micro, 0),
         repay_tx = p_repay_tx,
         updated_at = now()
   WHERE loan_id = p_loan_id;

  -- Only a positive cost reduces net revenue (a negative would mean the round-trip
  -- somehow gained, which we don't credit — clamp to a cost).
  IF COALESCE(p_financing_cost_micro, 0) > 0 THEN
    UPDATE public.platform_settings
       SET value = GREATEST(0, COALESCE(value::bigint, 0) - FLOOR(p_financing_cost_micro / 10000))::text
     WHERE key = 'platform_revenue_kobo';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.record_morpho_unwind(uuid, bigint, bigint, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_morpho_unwind(uuid, bigint, bigint, text) TO service_role;
