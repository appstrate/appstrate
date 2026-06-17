// SPDX-License-Identifier: Apache-2.0

import { pgTable, text, uuid, timestamp, jsonb, index, check } from "drizzle-orm/pg-core";
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
    // Same app-scoping as runs. Nullable because non-app-scoped
    // notification types (future) may have no application context.
    applicationId: text("application_id").references(() => applications.id, {
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
    // Unread-badge / list query: recipient + scope, unread only. Partial
    // index mirrors the old `idx_runs_unread` predicate so the badge count
    // never scans read rows.
    index("idx_notifications_unread")
      .on(table.applicationId, table.userId, table.endUserId)
      .where(sql`${table.readAt} IS NULL`),
    index("idx_notifications_run").on(table.runId),
    // Exactly one recipient column populated. XOR via inequality of the
    // two NULL-tests.
    check(
      "notifications_one_recipient",
      sql`(${table.userId} IS NULL) <> (${table.endUserId} IS NULL)`,
    ),
  ],
);
