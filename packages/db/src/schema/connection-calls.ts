// SPDX-License-Identifier: Apache-2.0

import { pgTable, text, timestamp, bigserial, integer, uuid, index } from "drizzle-orm/pg-core";

/**
 * Journal of the credential proxy's calls: one row per call that may have sent a connection's
 * credential, whatever its outcome. Written by `recordConnectionCall`
 * (`apps/api/src/services/credential-proxy/call-journal.ts`), best-effort like `recordAudit`.
 *
 * No foreign keys, on any column, for the reason `audit_events` states: the journal outlives the
 * organization, space, connection, run, key and principal it names, so every id here is a plain
 * value that may name a row that no longer exists.
 *
 * `owner_type` / `owner_id` are the connection's owner when the call was made (`user` /
 * `end_user`), NULL when the connection was gone by then. `actor_type` / `actor_id` are who acted,
 * `api_key_id` the key they acted through, if any.
 *
 * `host` and `path` come from the target as the caller wrote it, before substitution: a
 * `{{field}}` placeholder is stored as written and no query string is kept, so the row never holds
 * a decrypted credential value. `outcome` is the upstream's HTTP status as a string, or the
 * proxy's own problem code when the proxy answered itself.
 */
export const connectionCalls = pgTable(
  "connection_calls",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: uuid("org_id").notNull(),
    spaceId: text("space_id").notNull(),
    connectionId: uuid("connection_id").notNull(),
    integrationId: text("integration_id").notNull(),
    ownerType: text("owner_type"),
    ownerId: text("owner_id"),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    apiKeyId: text("api_key_id"),
    authMethod: text("auth_method").notNull(),
    runId: text("run_id"),
    method: text("method").notNull(),
    host: text("host").notNull(),
    path: text("path").notNull(),
    outcome: text("outcome").notNull(),
    durationMs: integer("duration_ms").notNull(),
    requestId: text("request_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Both reads page on `id DESC`: a space's calls, and one connection's.
    index("idx_connection_calls_space_id").on(table.spaceId, table.id),
    index("idx_connection_calls_connection_id").on(table.connectionId, table.id),
    index("idx_connection_calls_run").on(table.runId),
  ],
);
