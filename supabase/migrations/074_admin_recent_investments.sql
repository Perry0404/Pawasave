-- 074_admin_recent_investments.sql
-- Admin dashboard: show EACH investment bought/sold (not just the aggregate volume).
-- Unions the authoritative order records — tokenized-stock / pre-IPO buys (equity_orders)
-- and sells (equity_sales) — with the investor's display name + phone, newest first.
-- (GetEquity RWA orders can be UNIONed in here once that path is live.)
-- Idempotent (CREATE OR REPLACE).

CREATE OR REPLACE FUNCTION public.admin_recent_investments(p_limit int DEFAULT 50)
RETURNS TABLE (
  kind               text,
  side               text,
  symbol             text,
  user_id            uuid,
  display_name       text,
  phone              text,
  amount_cngn_micro  bigint,
  shares             numeric,
  status             text,
  reference          text,
  created_at         timestamptz
)
LANGUAGE sql SECURITY DEFINER AS $$
  SELECT * FROM (
    -- Buys (tokenized stock + pre-IPO) — amount is the cNGN the user spent.
    SELECT COALESCE(o.asset_type, 'stock')::text AS kind, 'buy'::text AS side, o.symbol,
           o.user_id, p.display_name, p.phone,
           COALESCE(o.amount_cngn_micro, 0)::bigint AS amount_cngn_micro, o.shares,
           o.status, o.broker_ref AS reference, o.created_at
    FROM public.equity_orders o
    LEFT JOIN public.profiles p ON p.id = o.user_id
    UNION ALL
    -- Sells — amount is the net cNGN credited back.
    SELECT 'stock'::text AS kind, 'sell'::text AS side, s.symbol,
           s.user_id, p.display_name, p.phone,
           COALESCE(s.cngn_net_micro, 0)::bigint AS amount_cngn_micro, s.shares,
           s.status, s.broker_ref AS reference, s.created_at
    FROM public.equity_sales s
    LEFT JOIN public.profiles p ON p.id = s.user_id
  ) x
  ORDER BY x.created_at DESC
  LIMIT GREATEST(1, LEAST(p_limit, 200));
$$;

GRANT EXECUTE ON FUNCTION public.admin_recent_investments(int) TO service_role;
