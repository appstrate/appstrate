// SPDX-License-Identifier: Apache-2.0

/**
 * Per-(application, integration) default connection — the org-wide baseline
 * the resolver uses for EVERY agent that consumes the integration, unless a
 * more specific layer overrides it.
 *
 * This is the cross-agent governance primitive that `integration_pins` is
 * not: a pin is keyed per `(agent, integration)`, so forcing one connection
 * across N agents meant N pin rows. An org default is keyed per
 * `(application, integration)` — one row covers every agent.
 *
 * `enforce` discriminates the two governance strengths:
 *
 *   - `enforce = false` — **soft default**. Sits just above the
 *     accessible-connections fallback: it kills the `must_choose` ambiguity
 *     for the common case while still letting a member express a personal
 *     preference (a member pin wins over a soft default).
 *
 *   - `enforce = true` — **org-wide force**. Sits just below the per-agent
 *     admin pin: it locks the choice for every actor on every agent,
 *     beating run/schedule overrides and member pins. A per-agent admin pin
 *     still wins (the agent-specific exception).
 *
 * Resolver cascade (see `apps/api/src/services/integration-connection-resolver.ts`):
 *
 *   1. admin pin           (integration_pins, user_id IS NULL)   ← per-agent force
 *   2. org default ENFORCE (this table, enforce = true)          ← org-wide force
 *   3. runs.connection_overrides
 *   4. schedules.connection_overrides
 *   5. member pin          (integration_pins, user_id = actor)   ← per-agent preference
 *   6. org default SOFT    (this table, enforce = false)         ← org-wide default
 *   7. fallback: actor's accessible connections (own + shared)
 *
 * Same invariants as admin pins: the referenced connection MUST be
 * `shared_with_org = true` (validation in the org-defaults service — an
 * admin can't coerce a member's personal connection). FK on connectionId is
 * ON DELETE CASCADE: when the connection vanishes the default disappears and
 * the resolver falls through to the next layer.
 */

import { pgTable, text, uuid, boolean, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
import { applications } from "./applications.ts";
import { packages } from "./packages.ts";
import { integrationConnections } from "./integrations.ts";

export const integrationOrgDefaults = pgTable(
  "integration_org_defaults",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    applicationId: text("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    /** Integration package this default governs. */
    integrationPackageId: text("integration_package_id")
      .notNull()
      .references(() => packages.id, { onDelete: "cascade" }),
    /** The connection every agent will use by default. Must be sharedWithOrg=true. */
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => integrationConnections.id, { onDelete: "cascade" }),
    /** true = org-wide force (locks members); false = soft default (members can deviate). */
    enforce: boolean("enforce").notNull().default(false),
    /** Admin who set the default. */
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    // One default per (application, integration).
    uniqueIndex("idx_integration_org_defaults_unique").on(
      table.applicationId,
      table.integrationPackageId,
    ),
    // Resolver hot path: load all defaults for an application in one query.
    index("idx_integration_org_defaults_app").on(table.applicationId),
    // Reverse lookup for the unshare / destructive-delete impact guard.
    index("idx_integration_org_defaults_connection").on(table.connectionId),
  ],
);
