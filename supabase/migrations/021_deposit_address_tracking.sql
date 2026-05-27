-- 021_deposit_address_tracking.sql
-- Track off-ramp deposit addresses from providers for audit and debugging
-- Ensures users can see where their withdrawal funds are being sent

ALTER TABLE public.transactions
ADD COLUMN IF NOT EXISTS provider_deposit_address TEXT,
ADD COLUMN IF NOT EXISTS provider_custody_tx_id TEXT;

-- Index for faster lookups by deposit address
CREATE INDEX IF NOT EXISTS idx_transactions_deposit_addr 
ON public.transactions(provider_deposit_address) 
WHERE provider_deposit_address IS NOT NULL;

-- RPC to log deposit address for a transaction
CREATE OR REPLACE FUNCTION public.set_transaction_deposit_address(
  p_reference          TEXT,
  p_deposit_address    TEXT,
  p_custody_tx_id      TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE public.transactions
  SET provider_deposit_address = p_deposit_address,
      provider_custody_tx_id = p_custody_tx_id
  WHERE reference = p_reference;
END;
$$;

-- View for admins to audit off-ramp deposit flow
CREATE OR REPLACE VIEW public.offramp_audit AS
  SELECT
    id,
    user_id,
    reference,
    amount_kobo,
    provider_deposit_address,
    provider_custody_tx_id,
    status,
    created_at
  FROM public.transactions
  WHERE type = 'withdrawal'
  ORDER BY created_at DESC;
