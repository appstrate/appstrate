-- Add detailed token usage and cost tracking to executions
ALTER TABLE public.executions
  ADD COLUMN IF NOT EXISTS token_usage JSONB,
  ADD COLUMN IF NOT EXISTS cost_usd NUMERIC(10,6);
