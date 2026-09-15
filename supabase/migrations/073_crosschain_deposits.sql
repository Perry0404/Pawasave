-- 073_crosschain_deposits.sql
-- Cross-chain stablecoin deposit: a user sends USDC/USDT to their (same-on-every-chain) HD
-- deposit address on any supported chain; a scanner detects it, a HyperFX cross-chain intent
-- converts it to cNGN on Base, and the user is credited. This migration adds the ledger +
-- idempotency for that pipeline (the on-chain work lives in lib/hyperfx.ts + the cron).
--
-- Idempotency: one row per (chain_key, src_tx_hash, src_log_index). The credit RPC only ever
-- credits a row once (status guard under FOR UPDATE), so re-scans and cron retries are safe.

-- ── per-chain scan cursor ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crosschain_scan_state (
  chain_key   TEXT PRIMARY KEY,
  last_block  BIGINT NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── detected deposits + lifecycle ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crosschain_deposits (
  id                 BIGSERIAL PRIMARY KEY,
  user_id            UUID NOT NULL,
  chain_key          TEXT NOT NULL,                 -- 'arbitrum' | 'bsc' | …
  token_symbol       TEXT NOT NULL,                 -- 'USDC' | 'USDT'
  src_tx_hash        TEXT NOT NULL,
  src_log_index      INTEGER NOT NULL,
  deposit_address    TEXT NOT NULL,
  raw_amount         NUMERIC NOT NULL,              -- token base units (chain decimals; BSC=18)
  token_decimals     INTEGER NOT NULL,
  swept_tx_hash      TEXT,                          -- deposit → custody on the source chain
  base_fill_ref      TEXT,                          -- the cNGN-on-Base settlement reference
  cngn_gross_micro   BIGINT,                        -- cNGN received on Base before fee
  fee_micro          BIGINT,                        -- deposit fee taken (lib/deposit-fee policy)
  cngn_net_micro     BIGINT,                        -- cNGN credited to the user
  status             TEXT NOT NULL DEFAULT 'detected'
                     CHECK (status IN ('detected','sweeping','settling','credited','failed')),
  error              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (chain_key, src_tx_hash, src_log_index)
);
CREATE INDEX IF NOT EXISTS idx_crosschain_deposits_user   ON public.crosschain_deposits (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crosschain_deposits_status ON public.crosschain_deposits (status);

ALTER TABLE public.crosschain_deposits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ccdep_owner_read ON public.crosschain_deposits;
CREATE POLICY ccdep_owner_read ON public.crosschain_deposits FOR SELECT USING (auth.uid() = user_id);

-- ── record a detection (idempotent insert) ───────────────────────────────────
-- Returns the row id (existing or new). The cron calls this the moment it sees an inbound
-- USDC/USDT transfer, before any on-chain work, so a crash mid-settle never loses the record.
CREATE OR REPLACE FUNCTION public.record_crosschain_deposit(
  p_user_id       UUID,
  p_chain_key     TEXT,
  p_token_symbol  TEXT,
  p_src_tx_hash   TEXT,
  p_src_log_index INTEGER,
  p_deposit_addr  TEXT,
  p_raw_amount    NUMERIC,
  p_token_decimals INTEGER
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_id BIGINT;
BEGIN
  INSERT INTO public.crosschain_deposits
    (user_id, chain_key, token_symbol, src_tx_hash, src_log_index, deposit_address, raw_amount, token_decimals)
  VALUES (p_user_id, p_chain_key, upper(p_token_symbol), p_src_tx_hash, p_src_log_index, p_deposit_addr, p_raw_amount, p_token_decimals)
  ON CONFLICT (chain_key, src_tx_hash, src_log_index) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM public.crosschain_deposits
    WHERE chain_key = p_chain_key AND src_tx_hash = p_src_tx_hash AND src_log_index = p_src_log_index;
  END IF;
  RETURN v_id;
END;
$$;
GRANT EXECUTE ON FUNCTION public.record_crosschain_deposit(UUID,TEXT,TEXT,TEXT,INTEGER,TEXT,NUMERIC,INTEGER) TO service_role;

-- ── advance a deposit's status (sweeping/settling/failed) ─────────────────────
CREATE OR REPLACE FUNCTION public.mark_crosschain_deposit(
  p_id BIGINT, p_status TEXT, p_swept_tx TEXT DEFAULT NULL, p_error TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE public.crosschain_deposits
  SET status = p_status,
      swept_tx_hash = COALESCE(p_swept_tx, swept_tx_hash),
      error = CASE WHEN p_status = 'failed' THEN p_error ELSE error END,
      updated_at = now()
  WHERE id = p_id AND status <> 'credited';   -- never regress a credited deposit
END;
$$;
GRANT EXECUTE ON FUNCTION public.mark_crosschain_deposit(BIGINT,TEXT,TEXT,TEXT) TO service_role;

-- ── credit the user (idempotent) ─────────────────────────────────────────────
-- Called once the cNGN has landed on Base for this deposit. Credits cNGN net of the deposit
-- fee, writes a 'deposit' transaction, and flips the row to 'credited'. Guarded so a retry or
-- double-scan never double-credits.
CREATE OR REPLACE FUNCTION public.credit_crosschain_deposit(
  p_id                BIGINT,
  p_cngn_gross_micro  BIGINT,
  p_fee_micro         BIGINT,
  p_base_fill_ref     TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  d          public.crosschain_deposits%rowtype;
  v_net      BIGINT;
BEGIN
  SELECT * INTO d FROM public.crosschain_deposits WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR d.status = 'credited' THEN
    RETURN FALSE; -- idempotent: already done or unknown
  END IF;
  IF p_cngn_gross_micro IS NULL OR p_cngn_gross_micro <= 0 THEN
    RAISE EXCEPTION 'credit_crosschain_deposit: gross required';
  END IF;

  v_net := GREATEST(0, p_cngn_gross_micro - GREATEST(0, COALESCE(p_fee_micro, 0)));

  UPDATE public.crosschain_deposits
  SET status = 'credited', cngn_gross_micro = p_cngn_gross_micro, fee_micro = COALESCE(p_fee_micro,0),
      cngn_net_micro = v_net, base_fill_ref = p_base_fill_ref, updated_at = now()
  WHERE id = d.id;

  -- Credit the user's cNGN balance (naira_kobo=0, cNGN in micro).
  PERFORM public.credit_wallet(d.user_id, 0, v_net);

  INSERT INTO public.transactions (user_id, type, direction, amount_kobo, amount_usdc_micro,
                                   platform_fee_kobo, description, reference, status, metadata)
  VALUES (d.user_id, 'deposit', 'credit', 0, v_net,
          (COALESCE(p_fee_micro,0) / 10000),
          format('Crypto deposit — %s on %s', d.token_symbol, d.chain_key),
          format('ccdep:%s:%s:%s', d.chain_key, d.src_tx_hash, d.src_log_index), 'completed',
          jsonb_build_object('chain', d.chain_key, 'token', d.token_symbol,
                             'raw_amount', d.raw_amount, 'gross_micro', p_cngn_gross_micro,
                             'fee_micro', COALESCE(p_fee_micro,0), 'base_ref', p_base_fill_ref))
  ON CONFLICT DO NOTHING;

  RETURN TRUE;
END;
$$;
GRANT EXECUTE ON FUNCTION public.credit_crosschain_deposit(BIGINT,BIGINT,BIGINT,TEXT) TO service_role;
