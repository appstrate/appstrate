-- Data-only: drop the persisted `available_model_ids` of every credential
-- belonging to a `modelDiscovery: { mode: "static" }` provider.
--
-- For those providers (subscription sign-ins: claude-code, codex) the served
-- model set is a pure function of (provider definition, vendored pricing
-- catalog) — the platform issues zero probes against them, so every
-- credential of a given provider necessarily resolved to the SAME list. The
-- column therefore never held per-credential information; it held a snapshot
-- taken once at discovery time and never refreshed, which is how users kept
-- being offered a two-generations-old model list after the provider
-- definition had already been corrected.
--
-- `resolveCredentialModelIds` (apps/api, services/model-providers/
-- credentials.ts) now derives the list on every read, and the discovery path
-- no longer writes it. The historical rows are consequently inert — but inert
-- data that contradicts what the API returns is a trap for the next person
-- reading the table, so clear it rather than leave two disagreeing answers on
-- disk. Nothing is lost: the value is recomputable from the catalog.
--
-- The provider ids are hardcoded on purpose: this migration is a snapshot of
-- which providers were static on 2026-07-27, not a live query of the module
-- registry (which lives in application code and moves independently). Should
-- another provider become static later, its rows go stale the same way and
-- want their own migration. Naturally re-runnable: a second pass matches no
-- row.
UPDATE model_provider_credentials
SET available_model_ids = NULL
WHERE provider_id IN ('claude-code', 'codex')
  AND available_model_ids IS NOT NULL;
