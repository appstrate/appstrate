-- Index the ten OAuth foreign-key columns `@better-auth/oauth-provider` 1.7.3
-- declares `index: true` on and that no migration has ever created.
--
-- WHY. PostgreSQL indexes a REFERENCED column (it must, to back the unique
-- constraint) but never the REFERENCING one. So every parent delete has to
-- prove no child row points at the row going away, and with no index that
-- proof is a sequential scan of the whole referencing table:
--
--   * a logout deletes a `session` row, and `oauth_access_tokens.session_id` /
--     `oauth_refresh_tokens.session_id` are `ON DELETE set null` targets — both
--     token tables are scanned end to end, per sign-out;
--   * a user deletion cascades into the same two tables plus `oauth_consents`
--     and `oauth_clients`, on `user_id`;
--   * a client deletion cascades into all three on `client_id`, and a refresh
--     token deletion into `oauth_access_tokens` on `refresh_id`.
--
-- `oauth_consents` had no index at all, and `/authorize` reads it by
-- (client_id, user_id, reference_id) on every request.
--
-- SHAPE ONLY. No row is written or rewritten (`docs/NO_TRANSITIONAL_CODE.md`
-- §2). The index set is exactly the plugin's own `index: true` declarations —
-- no speculative composites — and `apps/api/src/modules/oidc/test/unit/
-- better-auth-declared-indexes.test.ts` reads those declarations off the live
-- plugin object and fails when the Drizzle schema drops behind them again.
--
-- LOCKING. A plain `CREATE INDEX` takes a SHARE lock, blocking writes to the
-- table while it builds. `CONCURRENTLY` is not available here: drizzle runs the
-- whole file in one transaction and `CREATE INDEX CONCURRENTLY` cannot run
-- inside one. These tables hold short-lived tokens, so the build is seconds on
-- any real installation; an operator with an unusually large token table should
-- prune expired rows before deploying.
--
-- `IF NOT EXISTS` on each statement is what makes the file converge from either
-- end — a rerun, or an install an operator indexed by hand.
--
-- ROLLBACK: safe. A previous build simply stops using the indexes.

CREATE INDEX IF NOT EXISTS "idx_oauth_clients_user" ON "oauth_clients" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_oauth_refresh_tokens_client" ON "oauth_refresh_tokens" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_oauth_refresh_tokens_session" ON "oauth_refresh_tokens" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_oauth_refresh_tokens_user" ON "oauth_refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_oauth_access_tokens_client" ON "oauth_access_tokens" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_oauth_access_tokens_session" ON "oauth_access_tokens" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_oauth_access_tokens_user" ON "oauth_access_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_oauth_access_tokens_refresh" ON "oauth_access_tokens" USING btree ("refresh_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_oauth_consents_client" ON "oauth_consents" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_oauth_consents_user" ON "oauth_consents" USING btree ("user_id");
