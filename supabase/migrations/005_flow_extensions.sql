-- Add extensions column to flows and flow_versions tables.
-- Extensions are pi-adapter-specific tool definitions per flow.

ALTER TABLE public.flows ADD COLUMN IF NOT EXISTS extensions JSONB DEFAULT '[]';
ALTER TABLE public.flow_versions ADD COLUMN IF NOT EXISTS extensions JSONB DEFAULT '[]';

-- Update create_flow_version RPC to include extensions parameter
CREATE OR REPLACE FUNCTION public.create_flow_version(
  p_flow_id TEXT,
  p_manifest JSONB,
  p_prompt TEXT,
  p_skills JSONB,
  p_created_by UUID,
  p_extensions JSONB DEFAULT '[]'
) RETURNS INTEGER AS $$
DECLARE
  next_version INTEGER;
  new_id INTEGER;
BEGIN
  -- Get next version number for this flow
  SELECT COALESCE(MAX(version_number), 0) + 1 INTO next_version
  FROM public.flow_versions
  WHERE flow_id = p_flow_id;

  INSERT INTO public.flow_versions (flow_id, version_number, manifest, prompt, skills, extensions, created_by)
  VALUES (p_flow_id, next_version, p_manifest, p_prompt, p_skills, p_extensions, p_created_by)
  RETURNING id INTO new_id;

  RETURN new_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
