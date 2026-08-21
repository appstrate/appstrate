-- Drop 18 indexes that no query can use.
--
-- Forward-only and data-safe: DROP INDEX touches no rows, needs no backfill,
-- and breaks nothing that already exists. No column or table is altered here.
--
-- 14 are strict LEADING-PREFIX duplicates: a btree on (a) under an existing
-- non-partial index or constraint on (a, b, ...) serves every lookup, sort and
-- FK-cascade scan the narrow one does, by construction. Verified mechanically
-- column-by-column, both sides confirmed non-partial:
--   idx_runs_package_id                   < idx_runs_package_started
--   idx_run_logs_run_id                   < idx_run_logs_lookup
--   idx_llm_usage_org_id                  < idx_llm_usage_org_created
--   idx_credential_proxy_usage_org_id     < idx_credential_proxy_usage_org_created
--   idx_model_provider_credentials_org_id < idx_model_provider_credentials_org_provider
--   idx_packages_org_id                   < idx_packages_org_type
--   idx_package_versions_package_id       < package_versions_pkg_version_unique
--   idx_pkg_ver_deps_version_id           < pkg_ver_deps_unique
--   idx_integration_oauth_clients_app     < idx_integration_oauth_clients_lookup
--   idx_integration_org_defaults_app      < idx_integration_org_defaults_unique
--   idx_integration_pins_app_pkg          < idx_integration_pins_unique
--   idx_webhooks_application_id           < idx_webhooks_app_enabled
--   idx_org_invitations_token             < the UNIQUE constraint on token
--   idx_application_packages_app_id       < the PK on (application_id, package_id)
--
-- Negative control, deliberately NOT dropped: idx_runs_user_id looks like the
-- same shape, but its covering index idx_runs_notification was removed in
-- migration 0013 — it is load-bearing again.
--
-- 4 are read by nothing:
--   idx_webhook_deliveries_event_id  event_id is never a predicate (only
--     webhook_id is) and carries no unique constraint, so it is not an
--     idempotency key in disguise either.
--   idx_webhook_deliveries_status    status is never filtered — the only
--     delivery query is WHERE webhook_id = ? ORDER BY created_at DESC. The
--     single-column idx_webhook_deliveries_webhook_id stays: it serves that
--     query and the FK cascade.
--   idx_api_keys_key_prefix          key_prefix is only ever SELECTed for
--     display; auth looks up by key_hash through its unique index.
--   idx_model_provider_pairings_expires_at  partial on `consumed_at IS NULL`,
--     but the cleanup scan is DELETE ... WHERE expires_at < cutoff with no such
--     predicate (it removes consumed rows too, on purpose). The planner could
--     never prove the index predicate, so it was maintained on every write and
--     used by nothing.
--
-- Net effect on the hot write paths: runs, run_logs and llm_usage each lose one
-- index maintenance per INSERT.

-- `IF EXISTS` on every drop, and the `SET LOCAL lock_timeout` fence, are both
-- deliberate. Drizzle's pg dialect wraps EVERY pending migration in ONE
-- transaction (drizzle-orm/pg-core/dialect: `session.transaction(...)` around
-- the whole loop), which is what makes both necessary.
--
-- IF EXISTS: without it, one `index "..." does not exist` aborts not just these
-- 18 drops but every migration in the batch, and the deploy is wedged for good
-- — a retry re-runs the same failing statement. Installs here have provably
-- diverged before: 0002_fold_webhooks_tables.sql guards its own DDL with
-- `to_regclass(...) IS NULL` for exactly this reason. An index that is already
-- absent IS the intended end state, so skipping it is correct, not a silent
-- failure.
--
-- lock_timeout: DROP INDEX takes ACCESS EXCLUSIVE on the parent table, and this
-- set touches runs, run_logs and llm_usage. If a long query holds a lock when
-- the migration starts, the pending ACCESS EXCLUSIVE request queues AHEAD of
-- every subsequent query on that table — a slow deploy becomes a stall on the
-- hot write paths. Each drop is a fast catalog operation, so failing fast and
-- letting the deploy retry beats heading that queue.
--
-- `SET LOCAL`, not `SET`, and reset to DEFAULT at the end: a plain `SET` would
-- survive COMMIT onto the pooled connection, and either form would otherwise
-- bleed into migrations 0040+ running later in the SAME transaction. The fence
-- keeps the 3s budget scoped to exactly the statements below it.
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
DROP INDEX IF EXISTS "idx_api_keys_key_prefix";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_model_provider_credentials_org_id";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_model_provider_pairings_expires_at";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_org_invitations_token";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_application_packages_app_id";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_pkg_ver_deps_version_id";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_package_versions_package_id";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_packages_org_id";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_credential_proxy_usage_org_id";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_llm_usage_org_id";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_run_logs_run_id";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_runs_package_id";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_integration_oauth_clients_app";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_integration_pins_app_pkg";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_integration_org_defaults_app";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_webhook_deliveries_event_id";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_webhook_deliveries_status";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_webhooks_application_id";--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
