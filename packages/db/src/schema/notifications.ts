// SPDX-License-Identifier: Apache-2.0

import {
  pgTable,
  text,
  uuid,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { user } from "./auth.ts";
import { organizations } from "./organizations.ts";
import { applications, endUsers } from "./applications.ts";
import { runs } from "./runs.ts";

/**
 * In-app notifications — one row per recipient (fan-out on write).
 *
 * Replaces the previous design where read-state lived on the `runs` row
 * itself (`runs.notifiedAt` / `runs.readAt`), which made the read flag
 * global: marking a notification read flipped it for every viewer, and a
 * non-owner's mark-as-read silently matched zero rows (issue #667).
 *
 * Each notification belongs to exactly one recipient, modelled with the
 * same nullable `{userId, endUserId}` pair the rest of the codebase uses
 * for actor identity (`runs`, `integration_connections`, the SSE
 * subscriber, `lib/actor.ts`). A dashboard user OR an end-user — never
 * both — enforced by the `notifications_one_recipient` CHECK.
 *
 * `type` + `runId` play the standard `entity_type` / `entity_id` roles so
 * the table extends to non-run notifications (invitations, billing) later
 * without a schema change. `payload` carries the few fields the bell needs
 * to render without a join back to `runs` (`agent_id`, `status`).
 */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // Same app-scoping as runs. NOT NULL: every notification is app-scoped
    // (the `scopedWhere` reader always filters `application_id = ?`, so a NULL
    // would be unreachable). A future org-global notification type would need
    // both a nullable column and a scopedWhere change — deferred until it
    // exists (YAGNI) rather than shipping an unqueryable NULL today.
    applicationId: text("application_id")
      .notNull()
      .references(() => applications.id, {
        onDelete: "cascade",
      }),
    // Recipient — exactly one of the two is set (CHECK below).
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    endUserId: text("end_user_id").references(() => endUsers.id, { onDelete: "cascade" }),
    // Notification kind. "run_completed" today; extensible.
    type: text("type").notNull(),
    // Originating entity (the run, for "run_completed"). Null for types
    // that have no run. `runs.id` is a text (`exec_`-prefixed) id, so this
    // is text too. ON DELETE CASCADE: deleting a run drops its notifications.
    runId: text("run_id").references(() => runs.id, { onDelete: "cascade" }),
    // Render-without-join payload: { agent_id, status }.
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Unread-badge / list query: `org_id = ? AND application_id = ? AND
    // (user_id = ? OR end_user_id = ?) AND read_at IS NULL`. The recipient is
    // an OR across two columns, which a single composite btree cannot serve as
    // a range — so split into one partial index per recipient column. Postgres
    // bitmap-ORs the two for the OR predicate, and each is a tight
    // (org, app, recipient) seek restricted to unread rows by the partial
    // WHERE. `org_id` leads because every query filters it first (scopedWhere).
    index("idx_notifications_unread_user")
      .on(table.orgId, table.applicationId, table.userId)
      .where(sql`${table.readAt} IS NULL`),
    index("idx_notifications_unread_end_user")
      .on(table.orgId, table.applicationId, table.endUserId)
      .where(sql`${table.readAt} IS NULL`),
    index("idx_notifications_run").on(table.runId),
    // Defense-in-depth against a double fan-out: at most one notification of
    // a given type per (run, recipient). The fan-out path is already
    // exactly-once (finalizeRun CAS winner) and the backfill is historical-
    // only, so these never fire in practice — but they make a duplicate
    // structurally impossible if either invariant ever regresses. Two
    // partial indexes because the recipient is split across two columns.
    uniqueIndex("uq_notifications_run_user_type")
      .on(table.runId, table.userId, table.type)
      .where(sql`${table.userId} IS NOT NULL AND ${table.runId} IS NOT NULL`),
    uniqueIndex("uq_notifications_run_end_user_type")
      .on(table.runId, table.endUserId, table.type)
      .where(sql`${table.endUserId} IS NOT NULL AND ${table.runId} IS NOT NULL`),
    // Exactly one recipient column populated. XOR via inequality of the
    // two NULL-tests.
    check(
      "notifications_one_recipient",
      sql`(${table.userId} IS NULL) <> (${table.endUserId} IS NULL)`,
    ),
  ],
);
