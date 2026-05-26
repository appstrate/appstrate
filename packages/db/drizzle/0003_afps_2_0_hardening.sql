-- AFPS 2.0 hardening (audit 03c §D-1/D-2/D-4 — Phase G-B2).
--
-- Three CHECK constraints land in this migration:
--
--   1. `packages.draft_manifest` and `package_versions.manifest` MUST carry
--      `schema_version` matching `2.%` when present. AFPS 2.0 is the only
--      supported manifest format; there is no v1 back-compat reader, so
--      persisting a v1 manifest would silently rot in the JSONB column. The
--      gate is permissive when `schema_version` is absent (legacy draft rows
--      pre-dating the 2.0.2 lift may exist; the lift migration 0002 normalises
--      `mcp-server` rows specifically).
--
--   2. `integration_connections.auth_key` MUST match the AFPS §7.2 regex
--      `^[a-z][a-z0-9_]*$`. This mirrors the manifest-side validation
--      already enforced by `@afps-spec/schema` so the wire and the row
--      never disagree.
--
-- All three constraints assume clean data (no production data, no AFPS 1.x
-- back-compat per audit 03c). Phase C's 0002 backfill already normalised
-- mcp-server manifests; v2 draft/version manifests have never been written
-- without `schema_version: "2.x"`.

ALTER TABLE "packages"
  ADD CONSTRAINT "packages_draft_manifest_v2"
  CHECK (
    "draft_manifest" IS NULL
    OR ("draft_manifest" ->> 'schema_version') IS NULL
    OR ("draft_manifest" ->> 'schema_version') LIKE '2.%'
  );
--> statement-breakpoint
ALTER TABLE "package_versions"
  ADD CONSTRAINT "package_versions_manifest_v2"
  CHECK (
    "manifest" IS NULL
    OR ("manifest" ->> 'schema_version') IS NULL
    OR ("manifest" ->> 'schema_version') LIKE '2.%'
  );
--> statement-breakpoint
ALTER TABLE "integration_connections"
  ADD CONSTRAINT "integration_connections_auth_key_valid"
  CHECK ("auth_key" ~ '^[a-z][a-z0-9_]*$');
