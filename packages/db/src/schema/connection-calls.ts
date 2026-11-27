// SPDX-License-Identifier: Apache-2.0

import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  bigserial,
  integer,
  uuid,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";

/**
 * Journal of the upstream calls made for an integration: one row per call or MCP operation that
 * was dispatched to an upstream (and so may have reached it), with or without a credential,
 * whatever its outcome, from the credential proxy or a platform run's sidecar
 * (`POST /internal/integration-calls`). Written by `recordConnectionCalls`
 * (`apps/api/src/services/credential-proxy/call-journal.ts`), best-effort like `recordAudit`.
 *
 * No foreign keys, on any column, for the reason `audit_events` states: the journal outlives the
 * organization, space, connection, run, key and principal it names, so every id here is a plain
 * value that may name a row that no longer exists.
 *
 * `connection_id` is NULL when the integration binds no connection (unauthenticated, AFPS §7.2),
 * and `owner_*` with it (`connection_calls_no_connection_no_owner`). `owner_type` / `owner_id`
 * are the connection's owner when the call was made (`user` / `end_user`), NULL when the
 * connection was gone by then. `actor_type` / `actor_id` are who acted, `api_key_id` the key
 * they acted through, if any.
 *
 * `called_at` is when the call started and `call_id` its identity (a UUID minted where the call was
 * dispatched: the sidecar for a run's call, the platform otherwise); `(run_id, call_id)` is unique,
 * so a batch the sidecar sends twice is stored once. Both are NULL on a row recorded before
 * migration 0119 (never backfilled); `created_at` is when the row was written, which for a
 * sidecar-reported call is later than the call. `request_id` is the `Request-Id` of the platform
 * request that made the call, NULL for a call a run's sidecar reported (the batch's own request
 * is not the call's).
 *
 * `run_id` is the run the call belongs to, `chat_session_id` the conversation whose loopback
 * bearer issued it: at most one of the two (`connection_calls_one_context`).
 *
 * `host` comes from the target as the caller wrote it, before substitution: a `{{field}}`
 * placeholder is stored as written, so the row never holds a decrypted credential value; NULL for
 * an operation of a local MCP server. `outcome` is the upstream's HTTP status as a string, or the
 * proxy's (or sidecar's) own failure code when it answered itself after dispatch.
 */
export const connectionCalls = pgTable(
  "connection_calls",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: uuid("org_id").notNull(),
    spaceId: text("space_id").notNull(),
    connectionId: uuid("connection_id"),
    integrationId: text("integration_id").notNull(),
    ownerType: text("owner_type"),
    ownerId: text("owner_id"),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    apiKeyId: text("api_key_id"),
    authMethod: text("auth_method").notNull(),
    runId: text("run_id"),
    chatSessionId: text("chat_session_id"),
    method: text("method").notNull(),
    host: text("host"),
    outcome: text("outcome").notNull(),
    durationMs: integer("duration_ms").notNull(),
    requestId: text("request_id"),
    calledAt: timestamp("called_at", { withTimezone: true }),
    callId: uuid("call_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The reads page on `id DESC`: a space's calls, one connection's, conversation's or run's.
    index("idx_connection_calls_space_id").on(table.spaceId, table.id),
    index("idx_connection_calls_connection_id").on(table.connectionId, table.id),
    index("idx_connection_calls_chat_session_id")
      .on(table.chatSessionId, table.id)
      .where(sql`${table.chatSessionId} IS NOT NULL`),
    index("idx_connection_calls_run_id")
      .on(table.runId, table.id)
      .where(sql`${table.runId} IS NOT NULL`),
    // NULLs never collide: only a row with a `call_id` is deduplicated.
    // A run's call recorded once, whatever the sidecar retries. Partial: rows recorded before
    // migration 0119 carry no call id and stay out of it.
    uniqueIndex("uq_connection_calls_run_call")
      .on(table.runId, table.callId)
      .where(sql`${table.callId} IS NOT NULL`),
    check("connection_calls_one_context", sql`run_id IS NULL OR chat_session_id IS NULL`),
    check("connection_calls_actor_type_valid", sql`actor_type IN ('user', 'end_user')`),
    check(
      "connection_calls_no_connection_no_owner",
      sql`connection_id IS NOT NULL OR (owner_type IS NULL AND owner_id IS NULL)`,
    ),
    check(
      "connection_calls_owner_type_valid",
      sql`owner_type IS NULL OR owner_type IN ('user', 'end_user')`,
    ),
  ],
);
