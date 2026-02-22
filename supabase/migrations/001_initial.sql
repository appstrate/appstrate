-- ============================================================
-- Appstrate: Full schema (unified)
-- ============================================================

-- ============================================================
-- 1. Organizations & membership
-- ============================================================

CREATE TABLE public.organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE public.organization_members (
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (org_id, user_id)
);

CREATE INDEX idx_organization_members_user_id ON public.organization_members(user_id);

-- Check if the calling user is a member of the given org
CREATE OR REPLACE FUNCTION public.is_org_member(p_org_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.organization_members
    WHERE org_id = p_org_id AND user_id = auth.uid()
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Check if the calling user is an admin (or owner) of the given org
CREATE OR REPLACE FUNCTION public.is_org_admin(p_org_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.organization_members
    WHERE org_id = p_org_id
      AND user_id = auth.uid()
      AND role IN ('owner', 'admin')
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- ============================================================
-- 2. Profiles (extends auth.users)
-- ============================================================

CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT,
  language TEXT NOT NULL DEFAULT 'fr' CHECK (language IN ('fr', 'en')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'display_name', NEW.email)
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============================================================
-- 3. Flow configs (org-scoped, admin-only write)
-- ============================================================

CREATE TABLE public.flow_configs (
  org_id UUID NOT NULL REFERENCES public.organizations(id),
  flow_id TEXT NOT NULL,
  config JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (org_id, flow_id)
);

CREATE INDEX idx_flow_configs_org_id ON public.flow_configs(org_id);

-- ============================================================
-- 4. User-imported flows (built-in flows loaded from filesystem)
-- ============================================================

CREATE TABLE public.flows (
  id TEXT PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES public.organizations(id),
  manifest JSONB NOT NULL,
  prompt TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT flows_id_slug CHECK (id ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$')
);

CREATE INDEX idx_flows_org_id ON public.flows(org_id);

-- ============================================================
-- 5. Flow versions (audit trail, loosely coupled)
-- ============================================================

CREATE TABLE public.flow_versions (
  id SERIAL PRIMARY KEY,
  flow_id TEXT NOT NULL,  -- No FK to flows: preserve history after deletion
  version_number INTEGER NOT NULL,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(flow_id, version_number)
);

CREATE INDEX idx_flow_versions_flow_id ON public.flow_versions(flow_id, version_number DESC);

-- ============================================================
-- 6. Executions (org-scoped, per-user)
-- ============================================================

CREATE TABLE public.executions (
  id TEXT PRIMARY KEY,
  flow_id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id),
  org_id UUID NOT NULL REFERENCES public.organizations(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'success', 'failed', 'timeout', 'cancelled')),
  input JSONB,
  result JSONB,
  state JSONB,
  error TEXT,
  tokens_used INTEGER,
  token_usage JSONB,
  cost_usd NUMERIC(10,6),
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  duration INTEGER,
  schedule_id TEXT,
  flow_version_id INTEGER REFERENCES public.flow_versions(id)
);

CREATE INDEX idx_executions_flow_id ON public.executions(flow_id);
CREATE INDEX idx_executions_status ON public.executions(status);
CREATE INDEX idx_executions_user_id ON public.executions(user_id);
CREATE INDEX idx_executions_org_id ON public.executions(org_id);

-- ============================================================
-- 7. Execution logs (user_id + org_id denormalized for Realtime CDC)
-- ============================================================

CREATE TABLE public.execution_logs (
  id SERIAL PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES public.executions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id),
  org_id UUID NOT NULL REFERENCES public.organizations(id),
  type TEXT NOT NULL DEFAULT 'progress',
  event TEXT,
  message TEXT,
  data JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_execution_logs_execution_id ON public.execution_logs(execution_id);
CREATE INDEX idx_execution_logs_lookup ON public.execution_logs(execution_id, id);
CREATE INDEX idx_execution_logs_user_id ON public.execution_logs(user_id);
CREATE INDEX idx_execution_logs_org_id ON public.execution_logs(org_id);

-- ============================================================
-- 8. Flow schedules (org-scoped, per-user)
-- ============================================================

CREATE TABLE public.flow_schedules (
  id TEXT PRIMARY KEY,
  flow_id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id),
  org_id UUID NOT NULL REFERENCES public.organizations(id),
  name TEXT,
  enabled BOOLEAN DEFAULT true,
  cron_expression TEXT NOT NULL,
  timezone TEXT DEFAULT 'UTC',
  input JSONB,
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_schedules_flow_id ON public.flow_schedules(flow_id);
CREATE INDEX idx_schedules_user_id ON public.flow_schedules(user_id);
CREATE INDEX idx_flow_schedules_org_id ON public.flow_schedules(org_id);

-- ============================================================
-- 9. Schedule runs (distributed lock deduplication)
-- ============================================================

CREATE TABLE public.schedule_runs (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  schedule_id TEXT NOT NULL REFERENCES public.flow_schedules(id) ON DELETE CASCADE,
  fire_time TIMESTAMPTZ NOT NULL,
  execution_id TEXT REFERENCES public.executions(id) ON DELETE SET NULL,
  instance_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(schedule_id, fire_time)
);

CREATE INDEX idx_schedule_runs_created_at ON public.schedule_runs(created_at);

-- ============================================================
-- 10. Share tokens (one-time public execution links)
-- ============================================================

CREATE TABLE public.share_tokens (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  token TEXT NOT NULL UNIQUE,
  flow_id TEXT NOT NULL,
  org_id UUID NOT NULL REFERENCES public.organizations(id),
  created_by UUID NOT NULL REFERENCES auth.users(id),
  execution_id TEXT REFERENCES public.executions(id) ON DELETE SET NULL,
  consumed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_share_tokens_token ON public.share_tokens(token);
CREATE INDEX idx_share_tokens_flow_id ON public.share_tokens(flow_id);
CREATE INDEX idx_share_tokens_org_id ON public.share_tokens(org_id);

-- ============================================================
-- 11. Flow admin connections
-- ============================================================

CREATE TABLE public.flow_admin_connections (
  flow_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  org_id UUID NOT NULL REFERENCES public.organizations(id),
  admin_user_id UUID NOT NULL REFERENCES auth.users(id),
  connected_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (flow_id, service_id)
);

CREATE INDEX idx_flow_admin_connections_flow_id ON public.flow_admin_connections(flow_id);
CREATE INDEX idx_flow_admin_connections_org_id ON public.flow_admin_connections(org_id);

-- ============================================================
-- 12. Organization library: skills & extensions
-- ============================================================

CREATE TABLE public.org_skills (
  id TEXT NOT NULL,
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name TEXT,
  description TEXT,
  content TEXT NOT NULL,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (org_id, id)
);

CREATE TABLE public.org_extensions (
  id TEXT NOT NULL,
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name TEXT,
  description TEXT,
  content TEXT NOT NULL,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (org_id, id)
);

CREATE TABLE public.flow_skills (
  flow_id TEXT NOT NULL REFERENCES public.flows(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL,
  org_id UUID NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (flow_id, skill_id),
  FOREIGN KEY (org_id, skill_id) REFERENCES public.org_skills(org_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_flow_skills_org_skill ON public.flow_skills(org_id, skill_id);

CREATE TABLE public.flow_extensions (
  flow_id TEXT NOT NULL REFERENCES public.flows(id) ON DELETE CASCADE,
  extension_id TEXT NOT NULL,
  org_id UUID NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (flow_id, extension_id),
  FOREIGN KEY (org_id, extension_id) REFERENCES public.org_extensions(org_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_flow_extensions_org_ext ON public.flow_extensions(org_id, extension_id);

-- ============================================================
-- 13. Provider configs (connection manager)
-- ============================================================

CREATE TABLE public.provider_configs (
  id TEXT NOT NULL,
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  auth_mode TEXT NOT NULL CHECK (auth_mode IN ('oauth2', 'api_key', 'basic', 'custom')),
  display_name TEXT NOT NULL,
  -- OAuth2 fields (encrypted via AES-256-GCM)
  client_id_encrypted TEXT,
  client_secret_encrypted TEXT,
  authorization_url TEXT,
  token_url TEXT,
  refresh_url TEXT,
  default_scopes TEXT[] DEFAULT '{}',
  scope_separator TEXT DEFAULT ' ',
  pkce_enabled BOOLEAN DEFAULT true,
  authorization_params JSONB DEFAULT '{}',
  token_params JSONB DEFAULT '{}',
  -- Credential fields
  credential_schema JSONB,
  credential_field_name TEXT,
  credential_header_name TEXT,
  credential_header_prefix TEXT,
  -- URI restrictions
  authorized_uris TEXT[] DEFAULT '{}',
  allow_all_uris BOOLEAN DEFAULT false,
  -- Common
  icon_url TEXT,
  categories TEXT[] DEFAULT '{}',
  docs_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (org_id, id)
);

-- ============================================================
-- 14. Service connections (unified credential storage)
-- ============================================================

CREATE TABLE public.service_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL,
  flow_id TEXT,
  auth_mode TEXT NOT NULL CHECK (auth_mode IN ('oauth2', 'api_key', 'basic', 'custom')),
  credentials_encrypted TEXT NOT NULL,
  scopes_granted TEXT[] DEFAULT '{}',
  expires_at TIMESTAMPTZ,
  raw_token_response JSONB,
  connection_config JSONB DEFAULT '{}',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Unique constraint handling NULL flow_id:
-- Global connections: one per (org, user, provider)
-- Flow-specific: one per (org, user, provider, flow)
CREATE UNIQUE INDEX idx_service_connections_unique
  ON public.service_connections(org_id, user_id, provider_id, COALESCE(flow_id, '__global__'));

CREATE INDEX idx_service_connections_org_user ON public.service_connections(org_id, user_id);
CREATE INDEX idx_service_connections_provider ON public.service_connections(org_id, provider_id);
CREATE INDEX idx_service_connections_flow ON public.service_connections(org_id, flow_id) WHERE flow_id IS NOT NULL;

-- ============================================================
-- 15. OAuth states (short-lived, for in-flight OAuth flows)
-- ============================================================

CREATE TABLE public.oauth_states (
  state TEXT PRIMARY KEY,
  org_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  scopes_requested TEXT[] DEFAULT '{}',
  redirect_uri TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '10 minutes')
);

CREATE INDEX idx_oauth_states_expires ON public.oauth_states(expires_at);

-- ============================================================
-- Row Level Security
-- ============================================================

-- organizations
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "organizations_select" ON public.organizations
  FOR SELECT USING (public.is_org_member(id));

CREATE POLICY "organizations_update" ON public.organizations
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.organization_members
      WHERE org_id = id
        AND user_id = auth.uid()
        AND role = 'owner'
    )
  );

CREATE POLICY "organizations_insert" ON public.organizations
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

-- organization_members
ALTER TABLE public.organization_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org_members_select" ON public.organization_members
  FOR SELECT USING (public.is_org_member(org_id));

CREATE POLICY "org_members_insert" ON public.organization_members
  FOR INSERT WITH CHECK (public.is_org_admin(org_id));

CREATE POLICY "org_members_delete" ON public.organization_members
  FOR DELETE USING (public.is_org_admin(org_id));

CREATE POLICY "org_members_update" ON public.organization_members
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.organization_members AS om
      WHERE om.org_id = organization_members.org_id
        AND om.user_id = auth.uid()
        AND om.role = 'owner'
    )
  );

-- profiles
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "profiles_select" ON public.profiles
  FOR SELECT USING (true);

CREATE POLICY "profiles_update" ON public.profiles
  FOR UPDATE USING (auth.uid() = id);

-- flow_configs
ALTER TABLE public.flow_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "flow_configs_select" ON public.flow_configs
  FOR SELECT USING (public.is_org_member(org_id));

CREATE POLICY "flow_configs_insert" ON public.flow_configs
  FOR INSERT WITH CHECK (public.is_org_admin(org_id));

CREATE POLICY "flow_configs_update" ON public.flow_configs
  FOR UPDATE USING (public.is_org_admin(org_id));

CREATE POLICY "flow_configs_delete" ON public.flow_configs
  FOR DELETE USING (public.is_org_admin(org_id));

-- flows
ALTER TABLE public.flows ENABLE ROW LEVEL SECURITY;

CREATE POLICY "flows_select" ON public.flows
  FOR SELECT USING (public.is_org_member(org_id));

CREATE POLICY "flows_insert" ON public.flows
  FOR INSERT WITH CHECK (public.is_org_admin(org_id));

CREATE POLICY "flows_update" ON public.flows
  FOR UPDATE USING (public.is_org_admin(org_id));

CREATE POLICY "flows_delete" ON public.flows
  FOR DELETE USING (public.is_org_admin(org_id));

-- flow_versions
ALTER TABLE public.flow_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "flow_versions_select" ON public.flow_versions
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "flow_versions_insert" ON public.flow_versions
  FOR INSERT WITH CHECK (true);

-- executions
ALTER TABLE public.executions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "executions_select" ON public.executions
  FOR SELECT USING (public.is_org_member(org_id));

CREATE POLICY "executions_select_realtime" ON public.executions
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "executions_insert" ON public.executions
  FOR INSERT WITH CHECK (
    auth.uid() = user_id
    AND public.is_org_member(org_id)
  );

-- execution_logs
ALTER TABLE public.execution_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "execution_logs_select" ON public.execution_logs
  FOR SELECT USING (public.is_org_member(org_id));

CREATE POLICY "execution_logs_select_realtime" ON public.execution_logs
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "execution_logs_insert" ON public.execution_logs
  FOR INSERT WITH CHECK (public.is_org_member(org_id));

-- flow_schedules
ALTER TABLE public.flow_schedules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "flow_schedules_select" ON public.flow_schedules
  FOR SELECT USING (public.is_org_member(org_id));

CREATE POLICY "flow_schedules_insert" ON public.flow_schedules
  FOR INSERT WITH CHECK (
    auth.uid() = user_id
    AND public.is_org_member(org_id)
  );

CREATE POLICY "flow_schedules_update" ON public.flow_schedules
  FOR UPDATE USING (
    auth.uid() = user_id
    AND public.is_org_member(org_id)
  );

CREATE POLICY "flow_schedules_delete" ON public.flow_schedules
  FOR DELETE USING (
    auth.uid() = user_id
    AND public.is_org_member(org_id)
  );

-- schedule_runs (service role only)
ALTER TABLE public.schedule_runs ENABLE ROW LEVEL SECURITY;

-- share_tokens (service role only)
ALTER TABLE public.share_tokens ENABLE ROW LEVEL SECURITY;

-- flow_admin_connections
ALTER TABLE public.flow_admin_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "flow_admin_connections_select" ON public.flow_admin_connections
  FOR SELECT USING (public.is_org_member(org_id));

CREATE POLICY "flow_admin_connections_insert" ON public.flow_admin_connections
  FOR INSERT WITH CHECK (public.is_org_admin(org_id));

CREATE POLICY "flow_admin_connections_update" ON public.flow_admin_connections
  FOR UPDATE USING (public.is_org_admin(org_id));

CREATE POLICY "flow_admin_connections_delete" ON public.flow_admin_connections
  FOR DELETE USING (public.is_org_admin(org_id));

-- org_skills
ALTER TABLE public.org_skills ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org_skills_select" ON public.org_skills
  FOR SELECT USING (public.is_org_member(org_id));

CREATE POLICY "org_skills_insert" ON public.org_skills
  FOR INSERT WITH CHECK (public.is_org_admin(org_id));

CREATE POLICY "org_skills_update" ON public.org_skills
  FOR UPDATE USING (public.is_org_admin(org_id));

CREATE POLICY "org_skills_delete" ON public.org_skills
  FOR DELETE USING (public.is_org_admin(org_id));

-- org_extensions
ALTER TABLE public.org_extensions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org_extensions_select" ON public.org_extensions
  FOR SELECT USING (public.is_org_member(org_id));

CREATE POLICY "org_extensions_insert" ON public.org_extensions
  FOR INSERT WITH CHECK (public.is_org_admin(org_id));

CREATE POLICY "org_extensions_update" ON public.org_extensions
  FOR UPDATE USING (public.is_org_admin(org_id));

CREATE POLICY "org_extensions_delete" ON public.org_extensions
  FOR DELETE USING (public.is_org_admin(org_id));

-- flow_skills
ALTER TABLE public.flow_skills ENABLE ROW LEVEL SECURITY;

CREATE POLICY "flow_skills_select" ON public.flow_skills
  FOR SELECT USING (public.is_org_member(org_id));

CREATE POLICY "flow_skills_insert" ON public.flow_skills
  FOR INSERT WITH CHECK (public.is_org_admin(org_id));

CREATE POLICY "flow_skills_delete" ON public.flow_skills
  FOR DELETE USING (public.is_org_admin(org_id));

-- flow_extensions
ALTER TABLE public.flow_extensions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "flow_extensions_select" ON public.flow_extensions
  FOR SELECT USING (public.is_org_member(org_id));

CREATE POLICY "flow_extensions_insert" ON public.flow_extensions
  FOR INSERT WITH CHECK (public.is_org_admin(org_id));

CREATE POLICY "flow_extensions_delete" ON public.flow_extensions
  FOR DELETE USING (public.is_org_admin(org_id));

-- provider_configs
ALTER TABLE public.provider_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "provider_configs_select" ON public.provider_configs
  FOR SELECT USING (public.is_org_member(org_id));

CREATE POLICY "provider_configs_insert" ON public.provider_configs
  FOR INSERT WITH CHECK (public.is_org_admin(org_id));

CREATE POLICY "provider_configs_update" ON public.provider_configs
  FOR UPDATE USING (public.is_org_admin(org_id));

CREATE POLICY "provider_configs_delete" ON public.provider_configs
  FOR DELETE USING (public.is_org_admin(org_id));

-- service_connections
ALTER TABLE public.service_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "connections_own" ON public.service_connections
  FOR ALL USING (auth.uid() = user_id AND public.is_org_member(org_id));

CREATE POLICY "connections_admin_read" ON public.service_connections
  FOR SELECT USING (public.is_org_admin(org_id));

-- oauth_states
ALTER TABLE public.oauth_states ENABLE ROW LEVEL SECURITY;

CREATE POLICY "oauth_states_own" ON public.oauth_states
  FOR ALL USING (auth.uid() = user_id);

-- ============================================================
-- Functions / RPCs
-- ============================================================

-- Atomic schedule lock acquisition
CREATE OR REPLACE FUNCTION public.try_acquire_schedule_lock(
  p_schedule_id TEXT,
  p_fire_time TIMESTAMPTZ,
  p_instance_id TEXT
) RETURNS BOOLEAN AS $$
DECLARE
  lock_key BIGINT;
BEGIN
  lock_key := abs(hashtext(p_schedule_id || '|' || p_fire_time::text));

  IF NOT pg_try_advisory_xact_lock(lock_key) THEN
    RETURN FALSE;
  END IF;

  BEGIN
    INSERT INTO public.schedule_runs (schedule_id, fire_time, instance_id)
    VALUES (p_schedule_id, p_fire_time, p_instance_id);
    RETURN TRUE;
  EXCEPTION WHEN unique_violation THEN
    RETURN FALSE;
  END;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Atomically create a new flow version with auto-incremented version_number
CREATE OR REPLACE FUNCTION public.create_flow_version(
  p_flow_id TEXT,
  p_created_by UUID
) RETURNS INTEGER AS $$
DECLARE
  next_version INTEGER;
  new_id INTEGER;
BEGIN
  SELECT COALESCE(MAX(version_number), 0) + 1 INTO next_version
  FROM public.flow_versions
  WHERE flow_id = p_flow_id;

  INSERT INTO public.flow_versions (flow_id, version_number, created_by)
  VALUES (p_flow_id, next_version, p_created_by)
  RETURNING id INTO new_id;

  RETURN new_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Clean up old schedule_runs rows
CREATE OR REPLACE FUNCTION public.cleanup_old_schedule_runs(
  retention_days INTEGER DEFAULT 30
) RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM public.schedule_runs
  WHERE created_at < NOW() - (retention_days || ' days')::INTERVAL;

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Atomic consume function for share tokens
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

-- Upsert a service connection (delete + insert, atomic)
CREATE OR REPLACE FUNCTION public.upsert_service_connection(
  p_org_id UUID,
  p_user_id UUID,
  p_provider_id TEXT,
  p_flow_id TEXT DEFAULT NULL,
  p_auth_mode TEXT DEFAULT 'oauth2',
  p_credentials_encrypted TEXT DEFAULT '',
  p_scopes_granted TEXT[] DEFAULT '{}',
  p_expires_at TIMESTAMPTZ DEFAULT NULL,
  p_raw_token_response JSONB DEFAULT NULL,
  p_connection_config JSONB DEFAULT '{}'
) RETURNS void AS $$
BEGIN
  DELETE FROM public.service_connections
  WHERE org_id = p_org_id
    AND user_id = p_user_id
    AND provider_id = p_provider_id
    AND ((p_flow_id IS NULL AND flow_id IS NULL) OR flow_id = p_flow_id);

  INSERT INTO public.service_connections (
    org_id, user_id, provider_id, flow_id, auth_mode,
    credentials_encrypted, scopes_granted, expires_at,
    raw_token_response, connection_config, updated_at
  ) VALUES (
    p_org_id, p_user_id, p_provider_id, p_flow_id, p_auth_mode,
    p_credentials_encrypted, p_scopes_granted, p_expires_at,
    p_raw_token_response, p_connection_config, NOW()
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Delete a service connection (handles NULL flow_id)
CREATE OR REPLACE FUNCTION public.delete_service_connection(
  p_org_id UUID,
  p_user_id UUID,
  p_provider_id TEXT,
  p_flow_id TEXT DEFAULT NULL
) RETURNS void AS $$
BEGIN
  DELETE FROM public.service_connections
  WHERE org_id = p_org_id
    AND user_id = p_user_id
    AND provider_id = p_provider_id
    AND ((p_flow_id IS NULL AND flow_id IS NULL) OR flow_id = p_flow_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Cleanup expired OAuth states
CREATE OR REPLACE FUNCTION public.cleanup_expired_oauth_states()
RETURNS void AS $$
  DELETE FROM public.oauth_states WHERE expires_at < NOW();
$$ LANGUAGE sql SECURITY DEFINER;

-- ============================================================
-- Supabase Realtime: publish execution + org tables
-- ============================================================

ALTER PUBLICATION supabase_realtime ADD TABLE
  public.execution_logs,
  public.executions,
  public.organizations,
  public.organization_members;
