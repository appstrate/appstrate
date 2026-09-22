// SPDX-License-Identifier: Apache-2.0

/**
 * Per-(space, agent, integration, user?) connection pin — the SET of
 * connections (`connection_ids`) a run of that agent binds.
 *
 * Two scopes share this table, discriminated by `user_id`:
 *
 *   - `user_id IS NULL` — **admin force pin**. Applies to every actor
 *     running this agent. Written via admin-only endpoints. Cannot be
 *     overridden by member pins, run/schedule overrides, or fallback.
 *
 *   - `user_id IS NOT NULL` — **member preference pin**. The member's
 *     persisted "for MY runs of this agent, use MY connections X, Y" choice.
 *     Written via `/api/me/integration-pins/...` by the member themselves.
 *
 * Resolver cascade: see `apps/api/src/services/integration-connection-resolver.ts`.
 *
 * A pin must reference connections accessible to the actor at run time.
 * For admin pins, validation lives in the pin service (admin can't pin
 * a member's personal connection — would let them coerce credentials by
 * sleight of hand). For member pins, validation also lives in the
 * service (member can only pin a connection they themselves can see).
 *
 * `connection_ids` has no FK (Postgres has none on array elements), and that
 * is the point: a deleted member stays in the set, so the resolver refuses the
 * run with `pinned_connection_unavailable` instead of quietly binding the
 * survivors.
 */

import { pgTable, text, uuid, timestamp, index, uniqueIndex, check } from "drizzle-orm/pg-core";
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
    connectionIds: uuid("connection_ids").array().notNull(),
    /**
     * Who set the pin — admin id for admin pins, same as `user_id` for member
     * pins.
     *
     * WRITTEN, NEVER READ — written at four sites in
     * `integration-pins-service.ts`, never SELECTed, filtered, or serialized
     * into any DTO or OpenAPI response, and write-only since the column was
     * introduced (no reader was ever removed). Kept rather than dropped because
     * an admin pin's author is plausibly wanted in the UI — that is the open
     * decision, and dropping would discard attribution already collected.
     */
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
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
    // Reverse lookup (`connection_ids @> …`): the unshare guard refuses
    // turning sharedWithOrg off while a pin references the connection.
    index("idx_integration_pins_connection_ids").using("gin", table.connectionIds),
    // Member-pin partial index: lookups filtering by `user_id` (member
    // self-management endpoints + resolver layer 5) hit only the small
    // member-scoped subset, not the admin-pin majority.
    index("idx_integration_pins_user")
      .on(table.userId)
      .where(sql`${table.userId} IS NOT NULL`),
    // 10 = `MAX_CONNECTIONS_PER_INTEGRATION`, spelled out: the schema must not
    // pull `@appstrate/core/integration`'s AFPS graph into drizzle-kit.
    check(
      "integration_pins_connection_ids_cardinality",
      sql`cardinality(connection_ids) BETWEEN 1 AND 10`,
    ),
  ],
);
