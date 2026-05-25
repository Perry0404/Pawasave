-- 018_proxy_transfer.sql
-- Proxy Transfer feature: Manually move funds between master merchant wallet and member wallets
-- Credit: Merchant → Member (reduce platform, increase member)
-- Debit: Member → Merchant (increase platform, reduce member)

CREATE TABLE IF NOT EXISTS public.proxy_transfers (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  proxy_member_id      TEXT        NOT NULL,  -- From Xend (e.g., "member_xyz")
  action              TEXT        NOT NULL CHECK (action IN ('CREDIT', 'DEBIT')),
  amount_usdc_micro   BIGINT      NOT NULL CHECK (amount_usdc_micro > 0),
  description         TEXT,
  initiated_by        UUID        REFERENCES public.profiles(id) ON DELETE SET NULL,
  initiated_at        TIMESTAMP   NOT NULL DEFAULT NOW(),
  notes               TEXT
);

-- RPC for admin to transfer funds to/from proxy member
CREATE OR REPLACE FUNCTION public.proxy_transfer(
  p_proxy_member_id    TEXT,
  p_action             TEXT,
  p_amount_usdc_micro  BIGINT,
  p_description        TEXT DEFAULT NULL
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_result JSON;
BEGIN
  -- Only admins can call this
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Verify admin role
  PERFORM 1 FROM public.profiles
  WHERE id = auth.uid() AND role = 'admin'
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unauthorized: admin access required';
  END IF;

  -- Validate action
  IF p_action NOT IN ('CREDIT', 'DEBIT') THEN
    RAISE EXCEPTION 'Invalid action: must be CREDIT or DEBIT';
  END IF;

  -- Validate amount
  IF p_amount_usdc_micro <= 0 THEN
    RAISE EXCEPTION 'Amount must be positive';
  END IF;

  -- Insert transfer record
  INSERT INTO public.proxy_transfers (proxy_member_id, action, amount_usdc_micro, description, initiated_by)
  VALUES (p_proxy_member_id, p_action, p_amount_usdc_micro, p_description, auth.uid());

  -- For CREDIT: funds flow from platform (decrease platform_revenue, increase member in Xend)
  -- For DEBIT: funds flow to platform (increase platform_revenue, decrease member in Xend)
  -- The actual Xend wallet adjustment happens via their API (proxyFundsTransfer in backend)
  -- This RPC just logs the intent

  v_result := JSON_BUILD_OBJECT(
    'status', 'recorded',
    'action', p_action,
    'amount_usdc_micro', p_amount_usdc_micro,
    'proxy_member_id', p_proxy_member_id,
    'initiated_by', auth.uid()
  );

  RETURN v_result;
END;
$$;

-- RPC to view transfer history
CREATE OR REPLACE FUNCTION public.get_proxy_transfers(p_limit INT DEFAULT 50)
RETURNS TABLE (
  id UUID,
  proxy_member_id TEXT,
  action TEXT,
  amount_usdc_micro BIGINT,
  description TEXT,
  initiated_at TIMESTAMP,
  initiated_by_email TEXT
) 
LANGUAGE SQL SECURITY DEFINER AS $$
  SELECT
    pt.id,
    pt.proxy_member_id,
    pt.action,
    pt.amount_usdc_micro,
    pt.description,
    pt.initiated_at,
    p.email
  FROM public.proxy_transfers pt
  LEFT JOIN public.profiles p ON pt.initiated_by = p.id
  ORDER BY pt.initiated_at DESC
  LIMIT p_limit;
$$;
