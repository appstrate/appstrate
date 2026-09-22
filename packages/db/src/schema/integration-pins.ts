// SPDX-License-Identifier: Apache-2.0

/**
 * Per-(space, agent, integration, user?) connection pin. A pin is a SET of
 * connections: N rows sharing (space, agent, integration, scope) are one pin
 * binding N connections, which is why `connection_id` is part of the unique
 * index below.
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
 * Resolver cascade (see `apps/api/src/services/integration-connection-resolver.ts`).
 * EVERY layer yields a SET of connections; the first non-empty set wins whole —
 * sets are never merged across layers, so a member pin of two connections
 * replaces an org default of three rather than adding to it:
 *
 *   1. admin pin (this table, `user_id IS NULL`)        ← force, all actors
 *   2. org default ENFORCE (integration_org_defaults)
 *   3. runs.connection_overrides                          (run-time pick)
 *   4. schedules.connection_overrides                     (frozen at schedule create)
 *   5. member pin (this table, `user_id = actor.id`)    ← preference, this actor
 *   6. org default SOFT (integration_org_defaults)
 *   7. fallback: actor's accessible connections
 *      = own + (shared_with_org AND space match)
 *      → 1 match → auto, 0 → not_connected, N → must_choose
 *      (the fallback NEVER auto-binds a set of N)
 *
 * Writes REPLACE the whole set in one transaction — `PUT` carries the complete
 * set, `DELETE` clears it. There is no unitary add/remove endpoint, so a pin
 * is never observed half-written.
 *
 * Every pinned connection must be accessible to the actor at run time.
 * For admin pins, validation lives in the pin service (admin can't pin
 * a member's personal connection — would let them coerce credentials by
 * sleight of hand). For member pins, validation also lives in the
 * service (member can only pin a connection they themselves can see).
 *
 * FK on connectionId is ON DELETE CASCADE: when a pinned connection vanishes
 * its row disappears and the set shrinks; when the last one goes the resolver
 * naturally falls through to the next layer. No half-broken pin pointing at a
 * stale UUID.
 */

import { pgTable, text, uuid, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { user } from "./auth.ts";
import { spaces } from "./spaces.ts";
import { packages } from "./packages.ts";
import { integrationConnections } from "./integrations.ts";

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
    /** One member of the pinned set. CASCADE on delete. */
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => integrationConnections.id, { onDelete: "cascade" }),
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
    // One row per (space, agent, integration, scope, CONNECTION): the pin is a
    // set, so `connection_id` is what makes the members distinct while still
    // forbidding the same connection twice in one set. The coalesce trick keeps
    // the constraint usable for both scopes — empty-string sentinel on the NULL
    // side avoids PostgreSQL's "NULLs distinct in unique" caveat. Admin and
    // member pins can therefore coexist on the same (agent, integration).
    uniqueIndex("idx_integration_pins_unique").on(
      table.spaceId,
      table.packageId,
      table.integrationId,
      sql`coalesce(${table.userId}, '')`,
      table.connectionId,
    ),
    // Resolver hot path: fetch all pins for (space, agent) in one round trip,
    // then partition by user_id at space level.
    // Reverse lookup: "what pins reference this connection?" — used by
    // the unshare-guard (refuse turning sharedWithOrg off if pinned) AND
    // by the impact-list confirm modal on /connections destructive delete.
    index("idx_integration_pins_connection").on(table.connectionId),
    // Member-pin partial index: lookups filtering by `user_id` (member
    // self-management endpoints + resolver layer 5) hit only the small
    // member-scoped subset, not the admin-pin majority.
    index("idx_integration_pins_user")
      .on(table.userId)
      .where(sql`${table.userId} IS NOT NULL`),
  ],
);
