-- Step 1: Custom service credentials table
-- Stores credentials for custom (non-Nango) services, scoped per org+user+flow+service.

CREATE TABLE public.custom_service_credentials (
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  flow_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  credentials JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (org_id, user_id, flow_id, service_id)
);

ALTER TABLE public.custom_service_credentials ENABLE ROW LEVEL SECURITY;

-- Users can manage their own custom credentials within their org
CREATE POLICY "Users manage own custom credentials"
  ON public.custom_service_credentials FOR ALL
  USING (auth.uid() = user_id AND public.is_org_member(org_id));

-- Org admins can read all custom credentials (needed for admin connectionMode)
CREATE POLICY "Org admins read all custom credentials"
  ON public.custom_service_credentials FOR SELECT
  USING (public.is_org_admin(org_id));
