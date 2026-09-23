// SPDX-License-Identifier: Apache-2.0

/**
 * Per-(space, integration) default connection SET — the org-wide baseline
 * the resolver uses for EVERY agent that consumes the integration, unless a
 * more specific layer overrides it.
 *
 * This is the cross-agent governance primitive that `integration_pins` is
 * not: a pin is keyed per `(agent, integration)`, so forcing a connection
 * across N agents meant N pin rows. An org default is keyed per
 * `(space, integration)` — one row covers every agent.
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
 * Resolver cascade: see `apps/api/src/services/integration-connection-resolver.ts`.
 *
 * Same invariants as admin pins: every referenced connection MUST be
 * `shared_with_org = true` (validation in the org-defaults service — an
 * admin can't coerce a member's personal connection), and `connection_ids`
 * carries no FK for the same reason as `integration_pins.connection_ids`.
 */

import {
  pgTable,
  text,
  uuid,
  boolean,
  timestamp,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { user } from "./auth.ts";
import { spaces } from "./spaces.ts";
import { packages } from "./packages.ts";

export const integrationOrgDefaults = pgTable(
  "integration_org_defaults",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    spaceId: text("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    /** Integration package this default governs. */
    integrationId: text("integration_package_id")
      .notNull()
      .references(() => packages.id, { onDelete: "cascade" }),
    /** The set every agent binds by default. Each member must be sharedWithOrg=true. */
    connectionIds: uuid("connection_ids").array().notNull(),
    /** true = org-wide force (locks members); false = soft default (members can deviate). */
    enforce: boolean("enforce").notNull().default(false),
    /**
     * Admin who set the default.
     *
     * WRITTEN, NEVER READ — same shape as `integration_pins.created_by`:
     * written by `integration-org-defaults-service.ts`, never read back into
     * any response. Kept for the same reason (attribution an admin UI would
     * plausibly want) rather than dropped.
     */
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // One default per (space, integration).
    uniqueIndex("idx_integration_org_defaults_unique").on(table.spaceId, table.integrationId),
    // Reverse lookup (`connection_ids @> …`) for the unshare guard.
    index("idx_integration_org_defaults_connection_ids").using("gin", table.connectionIds),
    // 10 = `MAX_CONNECTIONS_PER_INTEGRATION`, spelled out: the schema must not
    // pull `@appstrate/core/integration`'s AFPS graph into drizzle-kit.
    check(
      "integration_org_defaults_connection_ids_cardinality",
      sql`cardinality(connection_ids) BETWEEN 1 AND 10`,
    ),
  ],
);
