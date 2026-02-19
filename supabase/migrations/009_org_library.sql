-- ============================================================
-- Organization-level Skills & Extensions Library
-- Migrates skills/extensions from per-flow ZIP to org-wide
-- shared library. Flows reference library items via join tables.
-- Full ZIP packages are stored in Supabase Storage (library-packages bucket).
-- The content column stores the main file text (SKILL.md / .ts) for display.
-- ============================================================

-- ============================================================
-- 1. org_skills — shared skill library per organization
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

-- ============================================================
-- 2. org_extensions — shared extension library per organization
-- ============================================================

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

-- ============================================================
-- 3. flow_skills — join table: flow <-> org_skill
-- ============================================================

CREATE TABLE public.flow_skills (
  flow_id TEXT NOT NULL REFERENCES public.flows(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL,
  org_id UUID NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (flow_id, skill_id),
  FOREIGN KEY (org_id, skill_id) REFERENCES public.org_skills(org_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_flow_skills_org_skill ON public.flow_skills(org_id, skill_id);

-- ============================================================
-- 4. flow_extensions — join table: flow <-> org_extension
-- ============================================================

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
-- 5. Enable RLS on all 4 tables
-- ============================================================

ALTER TABLE public.org_skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.org_extensions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flow_skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flow_extensions ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 6. RLS policies
-- ============================================================

-- org_skills: read by org members, write by org admins
CREATE POLICY "org_skills_select" ON public.org_skills
  FOR SELECT USING (public.is_org_member(org_id));

CREATE POLICY "org_skills_insert" ON public.org_skills
  FOR INSERT WITH CHECK (public.is_org_admin(org_id));

CREATE POLICY "org_skills_update" ON public.org_skills
  FOR UPDATE USING (public.is_org_admin(org_id));

CREATE POLICY "org_skills_delete" ON public.org_skills
  FOR DELETE USING (public.is_org_admin(org_id));

-- org_extensions: read by org members, write by org admins
CREATE POLICY "org_extensions_select" ON public.org_extensions
  FOR SELECT USING (public.is_org_member(org_id));

CREATE POLICY "org_extensions_insert" ON public.org_extensions
  FOR INSERT WITH CHECK (public.is_org_admin(org_id));

CREATE POLICY "org_extensions_update" ON public.org_extensions
  FOR UPDATE USING (public.is_org_admin(org_id));

CREATE POLICY "org_extensions_delete" ON public.org_extensions
  FOR DELETE USING (public.is_org_admin(org_id));

-- flow_skills: read by org members, write by org admins
CREATE POLICY "flow_skills_select" ON public.flow_skills
  FOR SELECT USING (public.is_org_member(org_id));

CREATE POLICY "flow_skills_insert" ON public.flow_skills
  FOR INSERT WITH CHECK (public.is_org_admin(org_id));

CREATE POLICY "flow_skills_delete" ON public.flow_skills
  FOR DELETE USING (public.is_org_admin(org_id));

-- flow_extensions: read by org members, write by org admins
CREATE POLICY "flow_extensions_select" ON public.flow_extensions
  FOR SELECT USING (public.is_org_member(org_id));

CREATE POLICY "flow_extensions_insert" ON public.flow_extensions
  FOR INSERT WITH CHECK (public.is_org_admin(org_id));

CREATE POLICY "flow_extensions_delete" ON public.flow_extensions
  FOR DELETE USING (public.is_org_admin(org_id));
