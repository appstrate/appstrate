-- AFPS 2.0.2 (§3.4 / §11.2): lift mcp-server identity from
-- `_meta["dev.afps/mcp-server"]` to the manifest root.
--
-- Pre-2.0.2 mcp-server manifests carried `type: "mcp-server"`, the scoped
-- `name`, and `schema_version` under `_meta["dev.afps/mcp-server"]`. 2.0.2
-- promoted all four (type, name, schema_version, dependencies) to the
-- manifest root and removed the `_meta["dev.afps/mcp-server"]` block.
--
-- This migration rewrites stored manifests in place so any rows authored
-- under v2.0.0 / v2.0.1 conform to the new shape:
--   - copy `_meta.dev.afps/mcp-server.name`         → root `name`
--   - set root `type` to "mcp-server"
--   - copy `_meta.dev.afps/mcp-server.schema_version` → root `schema_version`
--     (default "2.0" when absent)
--   - delete the `_meta["dev.afps/mcp-server"]` block
--
-- The vendor extension `_meta["dev.appstrate/mcp-server"]` (runtime override
-- for bun-native servers) is unchanged and survives the rewrite.
--
-- Idempotent: the WHERE clause skips rows that no longer carry the legacy
-- `_meta["dev.afps/mcp-server"]` slot.
--
-- Note on the `::text` cast: 0001 added `mcp-server` to the `package_type`
-- enum. PostgreSQL forbids using a freshly-added enum value in the same
-- transaction as its ALTER TYPE. drizzle-kit wraps each migration in a
-- transaction, so casting `type` to text in this migration's WHERE clause
-- sidesteps that lock-step requirement.

-- Draft (working copy) mcp-server manifests.
UPDATE "packages"
SET "draft_manifest" =
  ("draft_manifest" #- '{_meta,dev.afps/mcp-server}')
  || jsonb_build_object(
       'name', "draft_manifest" #>> '{_meta,dev.afps/mcp-server,name}',
       'type', 'mcp-server',
       'schema_version', COALESCE("draft_manifest" #>> '{_meta,dev.afps/mcp-server,schema_version}', '2.0')
     )
WHERE "type"::text = 'mcp-server'
  AND "draft_manifest" #> '{_meta,dev.afps/mcp-server}' IS NOT NULL;
--> statement-breakpoint
-- Published version snapshots — keyed on the legacy _meta block alone (the
-- version row's manifest carries its own copy of `type`, and the prior shape
-- stored `type: "mcp-server"` inside _meta rather than at the root).
UPDATE "package_versions"
SET "manifest" =
  ("manifest" #- '{_meta,dev.afps/mcp-server}')
  || jsonb_build_object(
       'name', "manifest" #>> '{_meta,dev.afps/mcp-server,name}',
       'type', 'mcp-server',
       'schema_version', COALESCE("manifest" #>> '{_meta,dev.afps/mcp-server,schema_version}', '2.0')
     )
WHERE "manifest" #> '{_meta,dev.afps/mcp-server}' IS NOT NULL;
