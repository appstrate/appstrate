-- Drop the (packageId, authKey, accountId, applicationId, owner) unique
-- index on integration_connections. Every successful OAuth callback now
-- INSERTs a new row; reconnect/upgrade target an explicit `connectionId`
-- threaded through the OAuth state record and update that single row.
--
-- Rationale: the upsert-by-accountId model collapsed every connection
-- onto the same row whenever identity extraction failed (no
-- `extractTokenIdentity`, no `id_token`, no userinfo endpoint) — the
-- default fallback `accountId="default"` meant clicking "Add another
-- connection" silently overwrote the existing row. Letting the user
-- own multiple rows even to the same upstream account is simpler and
-- matches the UX intent.

DROP INDEX IF EXISTS "idx_integration_conn_unique";

-- Replace with a non-unique covering index so the resolver's per-actor
-- lookup stays fast.
CREATE INDEX IF NOT EXISTS "idx_integration_conn_lookup" ON "integration_connections"
  ("integration_package_id", "auth_key", "application_id");
