// SPDX-License-Identifier: Apache-2.0

/**
 * Persistent state for browser-backed integration connections.
 *
 * A connection owns exactly one provider profile. Browser state and proxy
 * credentials are bearer material, so only opaque provider references and
 * encrypted envelopes are stored here. Leases serialize access to a profile:
 * concurrent Chromium sessions against the same marketplace account are both
 * unsafe (state loss on last-writer-wins shutdown) and a strong anti-abuse
 * signal upstream.
 */

import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { applications, endUsers } from "./applications.ts";
import { user } from "./auth.ts";
import { integrationConnections } from "./integrations.ts";
import { packages } from "./packages.ts";

export const browserConnectionBindings = pgTable(
  "browser_connection_bindings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => integrationConnections.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    /** Browser Use profile UUID or an opaque process-profile identifier. */
    profileRef: text("profile_ref").notNull(),
    /** Optional v1 keyring envelope containing a provider custom-proxy config. */
    proxyConfigEncrypted: text("proxy_config_encrypted"),
    status: text("status").notNull().default("ready"),
    /** Monotonic revision used to reject stale handoff/finalize writes. */
    stateVersion: integer("state_version").notNull().default(1),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("browser_connection_bindings_connection_unique").on(table.connectionId),
    index("browser_connection_bindings_provider_status_idx").on(table.provider, table.status),
    check(
      "browser_connection_bindings_provider_valid",
      sql`${table.provider} IN ('browser-use-cloud', 'process')`,
    ),
    check(
      "browser_connection_bindings_status_valid",
      sql`${table.status} IN ('ready', 'interaction_required', 'invalid', 'deleting')`,
    ),
    check(
      "browser_connection_bindings_profile_ref_bounded",
      sql`length(${table.profileRef}) BETWEEN 1 AND 512`,
    ),
    check("browser_connection_bindings_state_version_positive", sql`${table.stateVersion} > 0`),
  ],
);

export const browserConnectionAttempts = pgTable(
  "browser_connection_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    applicationId: text("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    integrationId: text("integration_package_id")
      .notNull()
      .references(() => packages.id, { onDelete: "cascade" }),
    authKey: text("auth_key").notNull(),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    endUserId: text("end_user_id").references(() => endUsers.id, { onDelete: "cascade" }),
    /** Existing connection for a reconnect, null while creating a new row. */
    connectionId: uuid("connection_id").references(() => integrationConnections.id, {
      onDelete: "cascade",
    }),
    targetProvider: text("target_provider").notNull(),
    /** Allocated before handoff so the first target proof writes the final profile. */
    profileRef: text("profile_ref"),
    proxyConfigEncrypted: text("proxy_config_encrypted"),
    /** SHA-256 of the one-time companion bearer token; the token is never stored. */
    tokenHash: text("token_hash").notNull(),
    status: text("status").notNull().default("pending"),
    /** Short-lived encrypted browser-state handoff, deleted after finalization. */
    handoffEncrypted: text("handoff_encrypted"),
    /** Encrypted provider live URL; only the attempt bearer may read it. */
    interactionEncrypted: text("interaction_encrypted"),
    errorCode: text("error_code"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("browser_connection_attempts_token_hash_unique").on(table.tokenHash),
    index("browser_connection_attempts_expiry_idx").on(table.status, table.expiresAt),
    index("browser_connection_attempts_actor_user_idx")
      .on(table.userId)
      .where(sql`${table.userId} IS NOT NULL`),
    index("browser_connection_attempts_actor_end_user_idx")
      .on(table.endUserId)
      .where(sql`${table.endUserId} IS NOT NULL`),
    check(
      "browser_connection_attempts_exactly_one_owner",
      sql`(${table.userId} IS NOT NULL AND ${table.endUserId} IS NULL) OR (${table.userId} IS NULL AND ${table.endUserId} IS NOT NULL)`,
    ),
    check(
      "browser_connection_attempts_auth_key_valid",
      sql`${table.authKey} ~ '^[a-z][a-z0-9_]*$'`,
    ),
    check(
      "browser_connection_attempts_provider_valid",
      sql`${table.targetProvider} IN ('browser-use-cloud', 'process')`,
    ),
    check(
      "browser_connection_attempts_status_valid",
      sql`${table.status} IN ('pending', 'claimed', 'state_received', 'provisioning', 'interaction_required', 'complete', 'failed', 'expired', 'cancelled')`,
    ),
    check(
      "browser_connection_attempts_token_hash_valid",
      sql`${table.tokenHash} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

export const browserSessionLeases = pgTable(
  "browser_session_leases",
  {
    bindingId: uuid("binding_id")
      .primaryKey()
      .references(() => browserConnectionBindings.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").notNull(),
    /** Fencing token increments on every takeover and guards stale releases. */
    fencingToken: bigint("fencing_token", { mode: "number" }).notNull().default(1),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("browser_session_leases_expiry_idx").on(table.expiresAt),
    check("browser_session_leases_owner_bounded", sql`length(${table.ownerId}) BETWEEN 1 AND 256`),
    check("browser_session_leases_fencing_positive", sql`${table.fencingToken} > 0`),
  ],
);

/** Durable outbox for deleting provider profiles after local credential deletion. */
export const browserProfileDeletions = pgTable(
  "browser_profile_deletions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: text("provider").notNull(),
    profileRef: text("profile_ref").notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow().notNull(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("browser_profile_deletions_provider_ref_unique").on(
      table.provider,
      table.profileRef,
    ),
    index("browser_profile_deletions_due_idx").on(table.nextAttemptAt),
    check(
      "browser_profile_deletions_provider_valid",
      sql`${table.provider} IN ('browser-use-cloud', 'process')`,
    ),
    check(
      "browser_profile_deletions_profile_ref_bounded",
      sql`length(${table.profileRef}) BETWEEN 1 AND 512`,
    ),
    check("browser_profile_deletions_attempts_valid", sql`${table.attempts} >= 0`),
  ],
);
