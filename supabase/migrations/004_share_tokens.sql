-- Share tokens for one-time public execution links
CREATE TABLE public.share_tokens (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  token TEXT NOT NULL UNIQUE,
  flow_id TEXT NOT NULL,
  created_by UUID NOT NULL REFERENCES auth.users(id),
  execution_id TEXT REFERENCES public.executions(id) ON DELETE SET NULL,
  consumed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_share_tokens_token ON public.share_tokens(token);
CREATE INDEX idx_share_tokens_flow_id ON public.share_tokens(flow_id);

ALTER TABLE public.share_tokens ENABLE ROW LEVEL SECURITY;

-- RLS: admins can read their own tokens via service role (backend only)
-- No direct user access needed since all share operations go through the API

-- Atomic consume function: marks token as used and returns its info
-- Returns empty if token is invalid, expired, or already consumed (no race condition)
CREATE OR REPLACE FUNCTION public.consume_share_token(p_token TEXT)
RETURNS TABLE (id TEXT, flow_id TEXT, created_by UUID) AS $$
BEGIN
  RETURN QUERY
  UPDATE public.share_tokens
  SET consumed_at = NOW()
  WHERE share_tokens.token = p_token
    AND consumed_at IS NULL
    AND expires_at > NOW()
  RETURNING share_tokens.id, share_tokens.flow_id, share_tokens.created_by;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
