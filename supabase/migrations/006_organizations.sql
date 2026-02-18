-- ============================================================
-- Organization multi-tenancy
-- Introduces organizations + membership, adds org_id to all
-- tenant-scoped tables, replaces profile-role-based RLS with
-- organization-membership-based RLS.
--
-- Safe for databases with existing data: creates a default org,
-- backfills org_id on all existing rows, then adds NOT NULL.
-- ============================================================

-- ============================================================
-- 1. New tables: organizations, organization_members
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

-- ============================================================
-- 2. RPC helper functions
-- ============================================================

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
-- 3. Create default org + members from existing data
-- ============================================================

-- Create a default organization from the first admin user (if any data exists).
-- If no users exist, no default org is created (fresh DB scenario).
DO $$
DECLARE
  v_admin_id UUID;
  v_default_org_id UUID;
BEGIN
  -- Find the first admin user (or first user if no admins)
  SELECT id INTO v_admin_id
  FROM public.profiles
  ORDER BY
    CASE WHEN role = 'admin' THEN 0 ELSE 1 END,
    created_at ASC
  LIMIT 1;

  -- Always create temp table (empty if no users)
  CREATE TEMP TABLE _default_org (id UUID);

  IF v_admin_id IS NOT NULL THEN
    -- Create a default org
    INSERT INTO public.organizations (name, slug, created_by)
    VALUES ('Default', 'default', v_admin_id)
    RETURNING id INTO v_default_org_id;

    -- Add the admin as owner
    INSERT INTO public.organization_members (org_id, user_id, role)
    VALUES (v_default_org_id, v_admin_id, 'owner');

    -- Add all other users as members
    INSERT INTO public.organization_members (org_id, user_id, role)
    SELECT v_default_org_id, id,
      CASE WHEN role = 'admin' THEN 'admin' ELSE 'member' END
    FROM public.profiles
    WHERE id != v_admin_id;

    INSERT INTO _default_org VALUES (v_default_org_id);
  END IF;
END $$;

-- ============================================================
-- 3b. Add org_id columns (nullable first), backfill, then NOT NULL
-- ============================================================

-- Add nullable columns
ALTER TABLE public.executions ADD COLUMN org_id UUID REFERENCES public.organizations(id);
ALTER TABLE public.execution_logs ADD COLUMN org_id UUID REFERENCES public.organizations(id);
ALTER TABLE public.flow_schedules ADD COLUMN org_id UUID REFERENCES public.organizations(id);
ALTER TABLE public.flows ADD COLUMN org_id UUID REFERENCES public.organizations(id);
ALTER TABLE public.flow_admin_connections ADD COLUMN org_id UUID REFERENCES public.organizations(id);
ALTER TABLE public.share_tokens ADD COLUMN org_id UUID REFERENCES public.organizations(id);

ALTER TABLE public.flow_configs DROP CONSTRAINT flow_configs_pkey;
ALTER TABLE public.flow_configs ADD COLUMN org_id UUID REFERENCES public.organizations(id);

-- Backfill existing rows with default org (if it exists)
DO $$
DECLARE
  v_default_org_id UUID;
BEGIN
  SELECT id INTO v_default_org_id FROM _default_org LIMIT 1;
  IF v_default_org_id IS NOT NULL THEN
    UPDATE public.executions SET org_id = v_default_org_id WHERE org_id IS NULL;
    UPDATE public.execution_logs SET org_id = v_default_org_id WHERE org_id IS NULL;
    UPDATE public.flow_schedules SET org_id = v_default_org_id WHERE org_id IS NULL;
    UPDATE public.flows SET org_id = v_default_org_id WHERE org_id IS NULL;
    UPDATE public.flow_admin_connections SET org_id = v_default_org_id WHERE org_id IS NULL;
    UPDATE public.share_tokens SET org_id = v_default_org_id WHERE org_id IS NULL;
    UPDATE public.flow_configs SET org_id = v_default_org_id WHERE org_id IS NULL;
  END IF;
END $$;

-- Drop temp table if it exists
DROP TABLE IF EXISTS _default_org;

-- Now set NOT NULL constraints
ALTER TABLE public.executions ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE public.execution_logs ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE public.flow_schedules ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE public.flows ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE public.flow_admin_connections ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE public.share_tokens ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE public.flow_configs ALTER COLUMN org_id SET NOT NULL;

-- Add PK and indexes
ALTER TABLE public.flow_configs ADD PRIMARY KEY (org_id, flow_id);

CREATE INDEX idx_executions_org_id ON public.executions(org_id);
CREATE INDEX idx_execution_logs_org_id ON public.execution_logs(org_id);
CREATE INDEX idx_flow_schedules_org_id ON public.flow_schedules(org_id);
CREATE INDEX idx_flows_org_id ON public.flows(org_id);
CREATE INDEX idx_flow_admin_connections_org_id ON public.flow_admin_connections(org_id);
CREATE INDEX idx_share_tokens_org_id ON public.share_tokens(org_id);
CREATE INDEX idx_flow_configs_org_id ON public.flow_configs(org_id);

-- ============================================================
-- 4. Drop ALL existing RLS policies (must happen before dropping profiles.role)
-- ============================================================

-- profiles
DROP POLICY IF EXISTS "profiles_select" ON public.profiles;
DROP POLICY IF EXISTS "profiles_update" ON public.profiles;

-- flow_configs
DROP POLICY IF EXISTS "flow_configs_select" ON public.flow_configs;
DROP POLICY IF EXISTS "flow_configs_insert" ON public.flow_configs;
DROP POLICY IF EXISTS "flow_configs_update" ON public.flow_configs;
DROP POLICY IF EXISTS "flow_configs_delete" ON public.flow_configs;

-- flows
DROP POLICY IF EXISTS "flows_select" ON public.flows;
DROP POLICY IF EXISTS "flows_insert" ON public.flows;
DROP POLICY IF EXISTS "flows_update" ON public.flows;
DROP POLICY IF EXISTS "flows_delete" ON public.flows;

-- flow_versions
DROP POLICY IF EXISTS "flow_versions_select" ON public.flow_versions;
DROP POLICY IF EXISTS "flow_versions_insert" ON public.flow_versions;

-- executions
DROP POLICY IF EXISTS "executions_user" ON public.executions;
DROP POLICY IF EXISTS "executions_admin" ON public.executions;

-- execution_logs
DROP POLICY IF EXISTS "execution_logs_user" ON public.execution_logs;
DROP POLICY IF EXISTS "execution_logs_admin" ON public.execution_logs;

-- flow_schedules
DROP POLICY IF EXISTS "flow_schedules_user" ON public.flow_schedules;
DROP POLICY IF EXISTS "flow_schedules_admin" ON public.flow_schedules;

-- flow_admin_connections
DROP POLICY IF EXISTS "flow_admin_connections_select" ON public.flow_admin_connections;
DROP POLICY IF EXISTS "flow_admin_connections_insert" ON public.flow_admin_connections;
DROP POLICY IF EXISTS "flow_admin_connections_update" ON public.flow_admin_connections;
DROP POLICY IF EXISTS "flow_admin_connections_delete" ON public.flow_admin_connections;

-- share_tokens (no user policies existed, but drop any just in case)
-- (none were defined, but being defensive)

-- schedule_runs (no policies existed, remains service-role only)
-- (none were defined)

-- ============================================================
-- 5. Remove role column from profiles (now safe — policies dropped)
-- ============================================================

ALTER TABLE public.profiles DROP COLUMN role;

-- ============================================================
-- 6. Replace handle_new_user trigger (no auto-admin logic)
-- ============================================================

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP FUNCTION IF EXISTS public.handle_new_user();

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
-- 7. Enable RLS on new tables
-- ============================================================

ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_members ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 8. Create new org-based RLS policies
-- ============================================================

-- -------------------------------------------------------
-- organizations
-- -------------------------------------------------------

-- Members can read their own organizations
CREATE POLICY "organizations_select" ON public.organizations
  FOR SELECT USING (public.is_org_member(id));

-- Only owners can update the organization
CREATE POLICY "organizations_update" ON public.organizations
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.organization_members
      WHERE org_id = id
        AND user_id = auth.uid()
        AND role = 'owner'
    )
  );

-- Any authenticated user can create an organization
CREATE POLICY "organizations_insert" ON public.organizations
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

-- -------------------------------------------------------
-- organization_members
-- -------------------------------------------------------

-- Members can see other members of their own org
CREATE POLICY "org_members_select" ON public.organization_members
  FOR SELECT USING (public.is_org_member(org_id));

-- Admins (and owners) can add members
CREATE POLICY "org_members_insert" ON public.organization_members
  FOR INSERT WITH CHECK (public.is_org_admin(org_id));

-- Admins (and owners) can remove members
CREATE POLICY "org_members_delete" ON public.organization_members
  FOR DELETE USING (public.is_org_admin(org_id));

-- Only owners can change member roles
CREATE POLICY "org_members_update" ON public.organization_members
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.organization_members AS om
      WHERE om.org_id = organization_members.org_id
        AND om.user_id = auth.uid()
        AND om.role = 'owner'
    )
  );

-- -------------------------------------------------------
-- profiles
-- -------------------------------------------------------

CREATE POLICY "profiles_select" ON public.profiles
  FOR SELECT USING (true);

CREATE POLICY "profiles_update" ON public.profiles
  FOR UPDATE USING (auth.uid() = id);

-- -------------------------------------------------------
-- flow_configs
-- -------------------------------------------------------

CREATE POLICY "flow_configs_select" ON public.flow_configs
  FOR SELECT USING (public.is_org_member(org_id));

CREATE POLICY "flow_configs_insert" ON public.flow_configs
  FOR INSERT WITH CHECK (public.is_org_admin(org_id));

CREATE POLICY "flow_configs_update" ON public.flow_configs
  FOR UPDATE USING (public.is_org_admin(org_id));

CREATE POLICY "flow_configs_delete" ON public.flow_configs
  FOR DELETE USING (public.is_org_admin(org_id));

-- -------------------------------------------------------
-- flows (user-imported)
-- -------------------------------------------------------

CREATE POLICY "flows_select" ON public.flows
  FOR SELECT USING (public.is_org_member(org_id));

CREATE POLICY "flows_insert" ON public.flows
  FOR INSERT WITH CHECK (public.is_org_admin(org_id));

CREATE POLICY "flows_update" ON public.flows
  FOR UPDATE USING (public.is_org_admin(org_id));

CREATE POLICY "flows_delete" ON public.flows
  FOR DELETE USING (public.is_org_admin(org_id));

-- -------------------------------------------------------
-- flow_versions (audit trail, loosely coupled)
-- -------------------------------------------------------

CREATE POLICY "flow_versions_select" ON public.flow_versions
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "flow_versions_insert" ON public.flow_versions
  FOR INSERT WITH CHECK (true);

-- -------------------------------------------------------
-- executions
-- -------------------------------------------------------

CREATE POLICY "executions_select" ON public.executions
  FOR SELECT USING (public.is_org_member(org_id));

CREATE POLICY "executions_insert" ON public.executions
  FOR INSERT WITH CHECK (
    auth.uid() = user_id
    AND public.is_org_member(org_id)
  );

-- -------------------------------------------------------
-- execution_logs
-- -------------------------------------------------------

CREATE POLICY "execution_logs_select" ON public.execution_logs
  FOR SELECT USING (public.is_org_member(org_id));

CREATE POLICY "execution_logs_insert" ON public.execution_logs
  FOR INSERT WITH CHECK (public.is_org_member(org_id));

-- -------------------------------------------------------
-- flow_schedules
-- -------------------------------------------------------

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

-- -------------------------------------------------------
-- flow_admin_connections
-- -------------------------------------------------------

CREATE POLICY "flow_admin_connections_select" ON public.flow_admin_connections
  FOR SELECT USING (public.is_org_member(org_id));

CREATE POLICY "flow_admin_connections_insert" ON public.flow_admin_connections
  FOR INSERT WITH CHECK (public.is_org_admin(org_id));

CREATE POLICY "flow_admin_connections_update" ON public.flow_admin_connections
  FOR UPDATE USING (public.is_org_admin(org_id));

CREATE POLICY "flow_admin_connections_delete" ON public.flow_admin_connections
  FOR DELETE USING (public.is_org_admin(org_id));

-- -------------------------------------------------------
-- share_tokens: RLS enabled, no direct user policies
-- All access goes through service role in the backend.
-- -------------------------------------------------------
-- (already enabled in 004_share_tokens.sql, no policies needed)

-- -------------------------------------------------------
-- schedule_runs: RLS enabled, no policies (service role only)
-- -------------------------------------------------------
-- (already enabled in 001_initial.sql, no policies needed)

-- ============================================================
-- 9. Add new tables to Supabase Realtime publication
-- ============================================================

ALTER PUBLICATION supabase_realtime ADD TABLE public.organizations, public.organization_members;
