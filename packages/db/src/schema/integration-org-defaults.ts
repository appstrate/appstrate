// SPDX-License-Identifier: Apache-2.0

/**
 * Per-(space, integration) default connection SET — the org-wide baseline the
 * resolver uses for EVERY agent that consumes the integration, unless a more
 * specific layer overrides it. N rows sharing (space, integration) are one
 * default binding N connections, which is why `connection_id` is part of the
 * unique index below.
 *
 * This is the cross-agent governance primitive that `integration_pins` is
 * not: a pin is keyed per `(agent, integration)`, so forcing a connection
 * across N agents meant N pin rows per connection. An org default is keyed per
 * `(space, integration)` — one set covers every agent.
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
 * The N rows of one (space, integration) share a single `enforce` BY
 * CONSTRUCTION: the service writes the whole set in one transaction, so the
 * column can never disagree row to row and the resolver reads it off any
 * member. Nothing in SQL enforces that, and nothing needs to — there is no
 * write path that touches one row of a set.
 *
 * Resolver cascade (see `apps/api/src/services/integration-connection-resolver.ts`).
 * EVERY layer yields a SET; the first non-empty set wins whole, sets are never
 * merged across layers:
 *
 *   1. admin pin           (integration_pins, user_id IS NULL)   ← per-agent force
 *   2. org default ENFORCE (this table, enforce = true)          ← org-wide force
 *   3. runs.connection_overrides
 *   4. schedules.connection_overrides
 *   5. member pin          (integration_pins, user_id = actor)   ← per-agent preference
 *   6. org default SOFT    (this table, enforce = false)         ← org-wide default
 *   7. fallback: actor's accessible connections (own + shared);
 *      1 → auto, 0 → not_connected, N → must_choose. Never auto-binds N.
 *
 * Writes REPLACE the whole set in one transaction — `PUT` carries the complete
 * set, `DELETE` clears it. There is no unitary add/remove endpoint.
 *
 * Same invariants as admin pins: every referenced connection MUST be
 * `shared_with_org = true` (validation in the org-defaults service — an
 * admin can't coerce a member's personal connection). FK on connectionId is
 * ON DELETE CASCADE: when a connection vanishes its row disappears and the set
 * shrinks; when the last one goes the resolver falls through to the next layer.
 */

import {
  pgTable,
  text,
  uuid,
  boolean,
  timestamp,
  index,
  uniqueIndex,
  foreignKey,
} from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
import { spaces } from "./spaces.ts";
import { packages } from "./packages.ts";
import { integrationConnections } from "./integrations.ts";

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
    /**
     * One member of the default set every agent uses. Must be sharedWithOrg=true.
     *
     * The FK is declared in the table-config block below with an EXPLICIT name.
     * Drizzle's generated name for it —
     * `integration_org_defaults_connection_id_integration_connections_id_fk` —
     * is 68 bytes, past Postgres' 63-byte identifier limit, so the catalog has
     * only ever held the silently truncated form. See the block for why that
     * matters.
     */
    connectionId: uuid("connection_id").notNull(),
    /**
     * true = org-wide force (locks members); false = soft default (members can
     * deviate). Uniform across the rows of one (space, integration) — see the
     * table doc.
     */
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
    // One row per (space, integration, CONNECTION): the default is a set, so
    // `connection_id` distinguishes its members while still forbidding the same
    // connection twice in one set.
    uniqueIndex("idx_integration_org_defaults_unique").on(
      table.spaceId,
      table.integrationId,
      table.connectionId,
    ),
    // Resolver hot path: load all defaults for a space in one query.
    // Reverse lookup for the unshare / destructive-delete impact guard.
    index("idx_integration_org_defaults_connection").on(table.connectionId),
    // EXPLICITLY NAMED (migration 0055), and it has to be.
    //
    // Drizzle derives an unnamed FK's name as
    // `<table>_<cols>_<refTable>_<refCols>_fk`, which here is 68 bytes.
    // Postgres truncates any identifier past NAMEDATALEN-1 = 63 bytes AT
    // CREATION, silently — so `0000_init.sql` asked for the 68-byte name and
    // every database, fresh or ancient, ended up holding
    // `integration_org_defaults_connection_id_integration_connections_`.
    //
    // Nothing notices until something addresses the constraint BY NAME, and
    // the thing that eventually does is drizzle-kit itself: change this FK's
    // `onDelete` or its target and `generate` emits
    // `DROP CONSTRAINT "<the 68-byte name>"`, which matches nothing, errors
    // 42704, and aborts the whole pending batch — every migration in the
    // release, on every database. That is a failed deploy discovered at boot,
    // which is exactly how the `audit_events_org_id_fkey` name drift was found
    // in beta.24.
    //
    // The explicit name below is 41 bytes and is what the catalog now holds,
    // renamed in place by 0055. Keep any future name here under 63 bytes; the
    // schema-vs-migrations parity test asserts it for every constraint.
    foreignKey({
      columns: [table.connectionId],
      foreignColumns: [integrationConnections.id],
      name: "integration_org_defaults_connection_id_fk",
    }).onDelete("cascade"),
  ],
);
