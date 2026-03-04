-- Migration 0014: Convert flow manifest requires.skills and requires.extensions
-- from JSON arrays (["@scope/name"]) to JSON objects ({"@scope/name": "*"})
-- All existing entries default to version "*" (wildcard).

-- Convert skills arrays to objects
UPDATE packages
SET manifest = jsonb_set(
  manifest, '{requires,skills}',
  (SELECT COALESCE(jsonb_object_agg(elem, '*'), '{}'::jsonb)
   FROM jsonb_array_elements_text(manifest->'requires'->'skills') AS elem)
)
WHERE type = 'flow'
  AND manifest->'requires'->'skills' IS NOT NULL
  AND jsonb_typeof(manifest->'requires'->'skills') = 'array';

-- Convert extensions arrays to objects
UPDATE packages
SET manifest = jsonb_set(
  manifest, '{requires,extensions}',
  (SELECT COALESCE(jsonb_object_agg(elem, '*'), '{}'::jsonb)
   FROM jsonb_array_elements_text(manifest->'requires'->'extensions') AS elem)
)
WHERE type = 'flow'
  AND manifest->'requires'->'extensions' IS NOT NULL
  AND jsonb_typeof(manifest->'requires'->'extensions') = 'array';
