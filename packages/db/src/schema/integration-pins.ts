// SPDX-License-Identifier: Apache-2.0

/**
 * Per-(space, agent, integration, user?) connection pin. Two scopes share this
 * table, discriminated by `user_id`, and they answer different questions:
 *
 *   - `user_id IS NULL` — **admin pin**: the FLOOR every run of this agent binds,
 *     whoever runs it. Written via admin-only endpoints. Always bound in pin
 *     order; no launch override (run or schedule), member pin, soft org default
 *     or fallback can narrow or replace it. `allow_additional_connections`
 *     decides what may ADD to it: `false` (closed) — nothing, an override naming
 *     an id outside the floor is `override_outranked`; `true` (open) — the run's
 *     selection (launch override, else the member pin) is bound after the floor,
 *     deduped, from the actor's accessible rows. An enforced org default on the
 *     same (space, integration) closes it whatever the flag (the writers refuse
 *     the pair with 409 `connection_additions_conflict`). A member pin never
 *     survives under a closed admin pin: every admin pin write or delete where
 *     the pin IS or WAS closed deletes the member pins of its (space, agent,
 *     integration) in the same transaction — masked, they never come back
 *     unasked. Only none → open, open → open and deleting an open pin keep them
 *     (deleting an open pin drops them all under an enforced org default,
 *     which masks them from then on, and else those strictly narrowing the floor —
 *     only floor ids, fewer than it holds, `{}` included: they added nothing
 *     and would otherwise bind fewer connections as written).
 *
 *   - `user_id IS NOT NULL` — **member pin**: the member's own SELECTION for
 *     their runs of this agent, written via `/api/me/integration-pins/...` by the
 *     member themselves. Ungoverned it binds as is; under an open admin pin it is
 *     the addition to the floor. It is written only where it binds: under a
 *     closed admin pin or an enforced org default the write is refused (409
 *     `connection_additions_blocked`). An enforced org default follows the
 *     closed admin pin's rule: every org default write or delete where the
 *     default IS or WAS enforced deletes every member pin of its (space,
 *     integration) in the same transaction (a closed admin pin left none, and
 *     the enforced default closes an open one), so no row an enforced default
 *     came to govern survives it. Stored as
 *     named, floor ids included. Never open (CHECK below).
 *
 * Effective set = floor ∪ selection (the resolver, `integration-connection-resolver.ts`).
 * A pin must reference connections reachable here: an admin pin only connections
 * SHARED into the space (an admin pinning a member's personal connection would
 * coerce their credential onto everyone), a member pin also their own; both
 * checked by the pin service on write and by the resolver at run time.
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
