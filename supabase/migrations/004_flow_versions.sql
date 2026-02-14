-- Flow versioning: immutable snapshots of user flow content.
-- Each create/update of a user flow produces a new version.
-- Executions reference the version they ran against.

CREATE TABLE IF NOT EXISTS public.flow_versions (
  id SERIAL PRIMARY KEY,
  flow_id TEXT NOT NULL,  -- No FK to flows: keep history even after flow deletion
  version_number INTEGER NOT NULL,
  manifest JSONB NOT NULL,
  prompt TEXT NOT NULL,
  skills JSONB DEFAULT '[]',
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(flow_id, version_number)
);

-- Enable RLS
ALTER TABLE public.flow_versions ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read versions
CREATE POLICY "Authenticated users can read flow versions"
  ON public.flow_versions FOR SELECT
  TO authenticated
  USING (true);

-- Admin-only write (via service role key in practice)
CREATE POLICY "Service role can insert flow versions"
  ON public.flow_versions FOR INSERT
  WITH CHECK (true);

-- Add version reference to executions
ALTER TABLE public.executions ADD COLUMN IF NOT EXISTS flow_version_id INTEGER REFERENCES public.flow_versions(id);

-- Index for querying versions by flow
CREATE INDEX IF NOT EXISTS idx_flow_versions_flow_id ON public.flow_versions(flow_id, version_number DESC);

-- RPC to atomically create a new version with auto-incremented version_number
CREATE OR REPLACE FUNCTION public.create_flow_version(
  p_flow_id TEXT,
  p_manifest JSONB,
  p_prompt TEXT,
  p_skills JSONB,
  p_created_by UUID
) RETURNS INTEGER AS $$
DECLARE
  next_version INTEGER;
  new_id INTEGER;
BEGIN
  -- Get next version number for this flow
  SELECT COALESCE(MAX(version_number), 0) + 1 INTO next_version
  FROM public.flow_versions
  WHERE flow_id = p_flow_id;

  INSERT INTO public.flow_versions (flow_id, version_number, manifest, prompt, skills, created_by)
  VALUES (p_flow_id, next_version, p_manifest, p_prompt, p_skills, p_created_by)
  RETURNING id INTO new_id;

  RETURN new_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
