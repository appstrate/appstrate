-- Migrate existing org-level provider credentials to application-level
-- Maps each org-level credential to the org's default application
INSERT INTO application_provider_credentials (application_id, provider_id, credentials_encrypted, enabled, created_at, updated_at)
SELECT a.id, pc.provider_id, pc.credentials_encrypted, pc.enabled, NOW(), pc.updated_at
FROM provider_credentials pc
JOIN applications a ON a.org_id = pc.org_id AND a.is_default = true
ON CONFLICT (application_id, provider_id) DO NOTHING;

DROP TABLE "provider_credentials" CASCADE;
