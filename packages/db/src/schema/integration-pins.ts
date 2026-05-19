// SPDX-License-Identifier: Apache-2.0

/**
 * Admin-set per-(application, agent, integration, authKey) connection pin.
 *
 * The highest-precedence layer in the integration connection resolver
 * (see `apps/api/src/services/integration-connection-resolver.ts`):
 *
 *   1. integration_pins         ← THIS table  (admin force)
 *   2. runs.connection_overrides                (run-time pick)
 *   3. schedules.connection_overrides           (frozen at schedule create)
 *   4. fallback: actor's accessible connections
 *      = own + (shared_with_org AND application match)
 *      → 1 match → auto, 0 → not_connected, N → must_choose
 *
 * A pin must reference a connection that is accessible to the actors
 * the agent runs as (i.e. owned by an admin AND shared with the org, OR
 * owned by the actor themselves — though admin-pinning a user's own
 * connection is rejected by the API service because that would let
 * admins coerce members into using their personal credentials by
 * sleight of hand). The validation lives in the pin service, not in
 * a DB constraint, because "accessible" depends on the actor at run
 * time (members vs end-users vs API key impersonation).
 *
 * FK on connectionId is ON DELETE CASCADE: when the pinned connection
 * vanishes, the pin row disappears and the resolver naturally falls
 * through to the next layer. No half-broken pin pointing at a stale
 * UUID.
 */

import { pgTable, text, uuid, timestamp, index, primaryKey } from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
import { applications } from "./applications.ts";
import { packages } from "./packages.ts";
import { integrationConnections } from "./integrations.ts";

export const integrationPins = pgTable(
  "integration_pins",
  {
    applicationId: text("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    /** Agent package (`packages.id`) — the pin is per-agent, not per-app-wide. */
    packageId: text("package_id")
      .notNull()
      .references(() => packages.id, { onDelete: "cascade" }),
    /** Integration package this pin governs. */
    integrationPackageId: text("integration_package_id")
      .notNull()
      .references(() => packages.id, { onDelete: "cascade" }),
    /** Auth key inside the integration manifest (`manifest.auths.{key}`). */
    authKey: text("auth_key").notNull(),
    /** The connection actors will be coerced to use. CASCADE on delete. */
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => integrationConnections.id, { onDelete: "cascade" }),
    /** Admin who set the pin — for audit. */
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.applicationId, table.packageId, table.integrationPackageId, table.authKey],
    }),
    // Resolver hot path: fetch all pins for (app, agent) in one round trip.
    index("idx_integration_pins_app_pkg").on(table.applicationId, table.packageId),
    // Reverse lookup: "what pins reference this connection?" — used by
    // the unshare-guard (refuse turning sharedWithOrg off if pinned).
    index("idx_integration_pins_connection").on(table.connectionId),
  ],
);
