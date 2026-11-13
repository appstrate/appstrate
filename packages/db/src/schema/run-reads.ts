// SPDX-License-Identifier: Apache-2.0

import { pgTable, text, uuid, timestamp, index, primaryKey, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "./organizations.ts";
import { spaces } from "./spaces.ts";
import { runs } from "./runs.ts";

/**
 * A finished run's read state, per recipient — one row per (run, recipient),
 * written when the run reaches a terminal status, `read_at` NULL until the
 * recipient opens it. It is what the run's `unread`, an agent's and a
 * schedule's `unread_count` and `GET /api/runs?unread=true` read.
 *
 * It is NOT a notification: `notifications` holds what the bell shows (a
 * failed run, a share), decided when it is written. A run is unread whether or
 * not anyone was notified about it.
 *
 * The recipient is the same polymorphic `(recipientType, recipientId)` tuple as
 * on `notifications` (the `Actor` shape): no FK on the id, so the deletion
 * sites of a member and an end-user clean their rows explicitly; the run, org
 * and space FKs cascade.
 */
export const runReads = pgTable(
  "run_reads",
  {
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    spaceId: text("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    recipientType: text("recipient_type").notNull().$type<"user" | "end_user">(),
    recipientId: text("recipient_id").notNull(),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Run-LEADING: serves the run FK cascade and the correlated `unread`
    // lookup (`run_id = runs.id` + recipient), and makes a double write for
    // one (run, recipient) structurally impossible.
    primaryKey({ columns: [table.runId, table.recipientType, table.recipientId] }),
    // The caller's unread runs in a space: the badge count, the per-agent
    // count, `?unread=true` and the bulk ack all read only unread rows.
    index("idx_run_reads_unread")
      .on(table.orgId, table.spaceId, table.recipientType, table.recipientId)
      .where(sql`${table.readAt} IS NULL`),
    // The two delete-by-recipient sites (member removal is org-wide, end-user
    // deletion adds the space), which also remove read rows, so the partial
    // index above cannot serve them. `space_id` last for the org-wide one.
    index("idx_run_reads_recipient").on(
      table.orgId,
      table.recipientType,
      table.recipientId,
      table.spaceId,
    ),
    // The space FK cascade states `space_id` alone.
    index("idx_run_reads_space").on(table.spaceId),
    check("run_reads_recipient_type_valid", sql`recipient_type IN ('user', 'end_user')`),
  ],
);
