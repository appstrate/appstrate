-- Add available_scopes column to provider_configs
ALTER TABLE public.provider_configs
  ADD COLUMN available_scopes JSONB DEFAULT '[]'::jsonb;
