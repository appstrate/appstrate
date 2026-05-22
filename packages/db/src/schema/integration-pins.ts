// SPDX-License-Identifier: Apache-2.0

/**
 * Per-(application, agent, integration, user?) connection pin.
 *
 * Two scopes share this table, discriminated by `user_id`:
 *
 *   - `user_id IS NULL` — **admin force pin**. Applies to every actor
 *     running this agent. Written via admin-only endpoints. Cannot be
 *     overridden by member pins, run/schedule overrides, or fallback.
 *
 *   - `user_id IS NOT NULL` — **member preference pin**. The member's
 *     persisted "for MY runs of this agent, use MY connection X" choice.
 *     Written via `/api/me/integration-pins/...` by the member themselves.
 *     Used to replace the ephemeral R5 localStorage pick with a record
 *     the resolver sees on every run.
 *
 * Resolver cascade (see `apps/api/src/services/integration-connection-resolver.ts`):
 *
 *   1. admin pin (this table, `user_id IS NULL`)        ← force, all actors
 *   2. runs.connection_overrides                          (run-time pick)
 *   3. schedules.connection_overrides                     (frozen at schedule create)
 *   4. member pin (this table, `user_id = actor.id`)    ← preference, this actor
 *   5. fallback: actor's accessible connections
 *      = own + (shared_with_org AND application match)
 *      → 1 match → auto, 0 → not_connected, N → must_choose
 *
 * A pin must reference a connection accessible to the actor at run time.
 * For admin pins, validation lives in the pin service (admin can't pin
 * a member's personal connection — would let them coerce credentials by
 * sleight of hand). For member pins, validation also lives in the
 * service (member can only pin a connection they themselves can see).
 *
 * FK on connectionId is ON DELETE CASCADE: when the pinned connection
 * vanishes, the pin row disappears and the resolver naturally falls
 * through to the next layer. No half-broken pin pointing at a stale
 * UUID.
 */

import { pgTable, text, uuid, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { user } from "./auth.ts";
import { applications } from "./applications.ts";
import { packages } from "./packages.ts";
import { integrationConnections } from "./integrations.ts";

export const integrationPins = pgTable(
  "integration_pins",
  {
    id: uuid("id").defaultRandom().primaryKey(),
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
    /**
     * Scope discriminator. NULL = admin force (whole org); NOT NULL = this
     * member's personal preference. End-users never own pins (they don't
     * pick agents — see the table-level doc).
     */
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    /** The connection actors will be coerced to use. CASCADE on delete. */
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => integrationConnections.id, { onDelete: "cascade" }),
    /** Who set the pin — admin id for admin pins, same as `user_id` for member pins. */
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // One row per (application, agent, integration, scope). The
    // coalesce trick keeps the unique constraint usable for both scopes —
    // empty-string sentinel on the NULL side avoids PostgreSQL's
    // "NULLs distinct in unique" caveat. Admin and member pins can
    // therefore coexist on the same (agent, integration).
    uniqueIndex("idx_integration_pins_unique").on(
      table.applicationId,
      table.packageId,
      table.integrationPackageId,
      sql`coalesce(${table.userId}, '')`,
    ),
    // Resolver hot path: fetch all pins for (app, agent) in one round trip,
    // then partition by user_id at app level.
    index("idx_integration_pins_app_pkg").on(table.applicationId, table.packageId),
    // Reverse lookup: "what pins reference this connection?" — used by
    // the unshare-guard (refuse turning sharedWithOrg off if pinned) AND
    // by the impact-list confirm modal on /connections destructive delete.
    index("idx_integration_pins_connection").on(table.connectionId),
    // Member-pin partial index: lookups filtering by `user_id` (member
    // self-management endpoints + resolver layer 4) hit only the small
    // member-scoped subset, not the admin-pin majority.
    index("idx_integration_pins_user")
      .on(table.userId)
      .where(sql`${table.userId} IS NOT NULL`),
  ],
);
