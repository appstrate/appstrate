// SPDX-License-Identifier: Apache-2.0

/**
 * Per-(space, agent, integration, user?) connection pin — a SET of connections (`connection_ids`).
 * Two scopes share this table, discriminated by `user_id`:
 *
 *   - `user_id IS NULL` — **admin pin**: the FLOOR every run of this agent binds, whoever runs it,
 *     written via admin-only endpoints. `allow_additional_connections` opens it to the run's
 *     selection (launch override, else the member pin), bound after it; closed, nothing adds.
 *   - `user_id IS NOT NULL` — **member pin**: the member's own selection for their runs of this
 *     agent, written via `/api/me/integration-pins/...`. Never open (CHECK below).
 *
 * Targets are checked on write and at run time: an admin pin names only connections SHARED into the
 * space (pinning a member's personal connection would coerce their credential onto everyone), a
 * member pin also their own. How the resolver binds them, and when a member pin is refused or
 * purged: `apps/api/src/services/integration-pins-service.ts` (`purgeMemberPins`).
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

export const integrationPins = pgTable(
  "integration_pins",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    spaceId: text("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    /** Agent package (`packages.id`) — the pin is per-agent, not per-space-wide. */
    packageId: text("package_id")
      .notNull()
      .references(() => packages.id, { onDelete: "cascade" }),
    /** Integration package this pin governs. */
    integrationId: text("integration_package_id")
      .notNull()
      .references(() => packages.id, { onDelete: "cascade" }),
    /**
     * Scope discriminator. NULL = admin force (whole org); NOT NULL = this
     * member's personal preference. End-users never own pins (they don't
     * pick agents — see the table-level doc).
     */
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    /** The bound set; `{}` pins to no connection (no row = no pin). */
    connectionIds: uuid("connection_ids").array().notNull(),
    /** Admin pin only: whether the run's selection may add to the floor (see the table doc). */
    allowAdditionalConnections: boolean("allow_additional_connections").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // One row per (space, agent, integration, scope). The
    // coalesce trick keeps the unique constraint usable for both scopes —
    // empty-string sentinel on the NULL side avoids PostgreSQL's
    // "NULLs distinct in unique" caveat. Admin and member pins can
    // therefore coexist on the same (agent, integration).
    uniqueIndex("idx_integration_pins_unique").on(
      table.spaceId,
      table.packageId,
      table.integrationId,
      sql`coalesce(${table.userId}, '')`,
    ),
    index("idx_integration_pins_connection_ids").using("gin", table.connectionIds),
    index("idx_integration_pins_user")
      .on(table.userId)
      .where(sql`${table.userId} IS NOT NULL`),
    // 20 = MAX_CONNECTIONS_PER_INTEGRATION, spelled out for drizzle-kit; no FK on elements, by design.
    // 0 is a pin to no connection: the layer wins and binds nothing.
    check(
      "integration_pins_connection_ids_cardinality",
      sql`cardinality(connection_ids) BETWEEN 0 AND 20`,
    ),
    // A member pin is a selection, never a floor: only an admin pin opens.
    check(
      "integration_pins_additions_admin_only",
      sql`user_id IS NULL OR NOT allow_additional_connections`,
    ),
    // An empty floor imposes nothing to add to: `[]` stays a pin to no connection, closed.
    check(
      "integration_pins_additions_need_imposed",
      sql`NOT allow_additional_connections OR cardinality(connection_ids) > 0`,
    ),
  ],
);
