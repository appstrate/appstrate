-- Move skills and extensions from separate DB columns into manifest.requires (source of truth).

-- Step 1a: Merge existing extensions data into manifest.requires.extensions
UPDATE public.flows
SET manifest = jsonb_set(
  manifest, '{requires,extensions}',
  COALESCE(extensions, '[]'::jsonb)
)
WHERE extensions IS NOT NULL AND extensions != '[]'::jsonb
  AND (manifest->'requires'->'extensions' IS NULL
    OR manifest->'requires'->'extensions' = '[]'::jsonb);

UPDATE public.flow_versions
SET manifest = jsonb_set(
  manifest, '{requires,extensions}',
  COALESCE(extensions, '[]'::jsonb)
)
WHERE extensions IS NOT NULL AND extensions != '[]'::jsonb
  AND (manifest->'requires'->'extensions' IS NULL
    OR manifest->'requires'->'extensions' = '[]'::jsonb);

-- Step 1b: Merge existing skills data into manifest.requires.skills
UPDATE public.flows
SET manifest = jsonb_set(
  manifest, '{requires,skills}',
  COALESCE(skills, '[]'::jsonb)
)
WHERE skills IS NOT NULL AND skills != '[]'::jsonb
  AND (manifest->'requires'->'skills' IS NULL
    OR manifest->'requires'->'skills' = '[]'::jsonb);

UPDATE public.flow_versions
SET manifest = jsonb_set(
  manifest, '{requires,skills}',
  COALESCE(skills, '[]'::jsonb)
)
WHERE skills IS NOT NULL AND skills != '[]'::jsonb
  AND (manifest->'requires'->'skills' IS NULL
    OR manifest->'requires'->'skills' = '[]'::jsonb);

-- Step 2: Drop columns
ALTER TABLE public.flows DROP COLUMN IF EXISTS extensions;
ALTER TABLE public.flows DROP COLUMN IF EXISTS skills;
ALTER TABLE public.flow_versions DROP COLUMN IF EXISTS extensions;
ALTER TABLE public.flow_versions DROP COLUMN IF EXISTS skills;

-- Step 3: Update RPC (remove p_skills and p_extensions parameters)
CREATE OR REPLACE FUNCTION public.create_flow_version(
  p_flow_id TEXT,
  p_manifest JSONB,
  p_prompt TEXT,
  p_created_by UUID
) RETURNS INTEGER AS $$
DECLARE
  next_version INTEGER;
  new_id INTEGER;
BEGIN
  SELECT COALESCE(MAX(version_number), 0) + 1 INTO next_version
  FROM public.flow_versions
  WHERE flow_id = p_flow_id;

  INSERT INTO public.flow_versions (flow_id, version_number, manifest, prompt, created_by)
  VALUES (p_flow_id, next_version, p_manifest, p_prompt, p_created_by)
  RETURNING id INTO new_id;

  RETURN new_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
