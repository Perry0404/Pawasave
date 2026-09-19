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
  cngn_micro   bigint NOT NULL DEFAULT 0,   -- cNGN received from HyperFX (0 while 'settling')
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
