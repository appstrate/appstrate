-- Rename the camelCase keys inside the organizations.org_settings JSONB blob to
-- snake_case, matching the wire-casing migration that renamed the OpenAPI/serializer
-- fields (apiVersion -> api_version, dashboardSsoEnabled -> dashboard_sso_enabled).
--
-- org_settings is read back verbatim on GET /api/orgs/:orgId/settings and gates
-- org-level OAuth SSO (oidc routes read settings.dashboard_sso_enabled). Without
-- this backfill, existing rows keep the old camelCase keys, so the snake_case reads
-- resolve to undefined and SSO is silently disabled for orgs that had it enabled.
--
-- Idempotent: the WHERE guard makes re-runs no-ops once the old keys are gone.
UPDATE organizations
SET org_settings = (org_settings - 'dashboardSsoEnabled' - 'apiVersion')
  || (CASE WHEN org_settings ? 'dashboardSsoEnabled'
        THEN jsonb_build_object('dashboard_sso_enabled', org_settings -> 'dashboardSsoEnabled')
        ELSE '{}'::jsonb END)
  || (CASE WHEN org_settings ? 'apiVersion'
        THEN jsonb_build_object('api_version', org_settings -> 'apiVersion')
        ELSE '{}'::jsonb END)
WHERE org_settings ?| array['dashboardSsoEnabled', 'apiVersion'];
