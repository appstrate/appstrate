-- AFPS 2.0 migration.
--
-- Add the `mcp-server` package type (AFPS 2.0 §3.4) to the package_type enum.
-- An integration whose `source.kind: "local"` references a separate mcp-server
-- package via `source.server`.
--
-- There is no production data and no AFPS 1.x back-compat: manifests are stored
-- and read as native AFPS 2.0 (snake_case), so no JSONB data rewrite is needed.

ALTER TYPE "public"."package_type" ADD VALUE IF NOT EXISTS 'mcp-server';
