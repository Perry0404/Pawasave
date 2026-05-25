-- 020_proxy_member_mapping.sql
-- Links Xend proxy member IDs to PawaSave users for automatic deposit routing

CREATE TABLE IF NOT EXISTS public.proxy_member_accounts (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID        NOT NULL UNIQUE REFERENCES public.profiles(id) ON DELETE CASCADE,
  proxy_member_id       TEXT        NOT NULL UNIQUE,
  provider              TEXT        NOT NULL DEFAULT 'xend',
  created_at            TIMESTAMP   NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMP   NOT NULL DEFAULT NOW()
);

ALTER TABLE public.proxy_member_accounts ENABLE ROW LEVEL SECURITY;

-- RPC to register proxy member for a user
CREATE OR REPLACE FUNCTION public.register_proxy_member(
  p_user_id         UUID,
  p_proxy_member_id TEXT,
  p_provider        TEXT DEFAULT 'xend'
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  -- Only admin or authenticated user can register their own proxy
  IF auth.uid() IS NOT NULL AND auth.uid() != p_user_id THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  INSERT INTO public.proxy_member_accounts (user_id, proxy_member_id, provider)
  VALUES (p_user_id, p_proxy_member_id, p_provider)
  ON CONFLICT (proxy_member_id) DO UPDATE
  SET user_id = p_user_id, updated_at = NOW();

  RETURN JSON_BUILD_OBJECT(
    'status', 'registered',
    'user_id', p_user_id,
    'proxy_member_id', p_proxy_member_id,
    'provider', p_provider
  );
END;
$$;

-- RPC to look up user from proxy member ID (for webhook routing)
CREATE OR REPLACE FUNCTION public.get_user_for_proxy_member(p_proxy_member_id TEXT)
RETURNS UUID
LANGUAGE SQL SECURITY DEFINER AS $$
  SELECT user_id FROM public.proxy_member_accounts
  WHERE proxy_member_id = p_proxy_member_id
  LIMIT 1;
$$;

-- RPC to get proxy member ID for a user
CREATE OR REPLACE FUNCTION public.get_proxy_member_for_user(p_user_id UUID)
RETURNS TEXT
LANGUAGE SQL SECURITY DEFINER AS $$
  SELECT proxy_member_id FROM public.proxy_member_accounts
  WHERE user_id = p_user_id
  LIMIT 1;
$$;
