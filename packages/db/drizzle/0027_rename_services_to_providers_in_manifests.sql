-- Move requires.services → requires.providers in stored manifests
UPDATE packages SET manifest = jsonb_set(
  manifest #- '{requires,services}',
  '{requires,providers}',
  manifest->'requires'->'services'
)
WHERE manifest->'requires'->'services' IS NOT NULL
  AND manifest->'requires'->'services' != 'null'::jsonb;

-- Move servicesConfiguration → providersConfiguration in stored manifests
UPDATE packages SET manifest = (manifest - 'servicesConfiguration') ||
  jsonb_build_object('providersConfiguration', manifest->'servicesConfiguration')
WHERE manifest->'servicesConfiguration' IS NOT NULL
  AND manifest->'servicesConfiguration' != 'null'::jsonb;
