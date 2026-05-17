-- Phase 1.0 — INTEGRATIONS_PROPOSAL §4.1.
--
-- Adds the `integration` value to the `package_type` PG enum. Bundles
-- carrying `type: "integration"` (AFPS integration manifests, proposal
-- §4.1.1) become importable into the `packages` table without any
-- breaking change to the existing 4-type set.
--
-- Phase 1.0 stops at storage: the runtime side (spawn, credential
-- proxy, MCP Router) lands in Phase 1.2a. An imported integration is
-- visible in the registry but the agent runner cannot consume it yet.
--
-- Idempotent: ADD VALUE IF NOT EXISTS is a no-op when re-run (dev
-- replays + PGlite seed loops). Postgres requires this statement to
-- run OUTSIDE a transaction block, hence no DO $$ wrapper.

ALTER TYPE "package_type" ADD VALUE IF NOT EXISTS 'integration';
