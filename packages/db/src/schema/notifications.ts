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
import { organizations } from "./organizations.ts";
import { applications } from "./applications.ts";
import { runs } from "./runs.ts";

/**
 * In-app notifications — one row per recipient (fan-out on write).
 *
 * Replaces the previous design where read-state lived on the `runs` row
 * itself (`runs.notifiedAt` / `runs.readAt`), which made the read flag
 * global: marking a notification read flipped it for every viewer, and a
 * non-owner's mark-as-read silently matched zero rows (issue #667).
 *
 * The recipient is modelled as a single polymorphic pair
 * (`recipientType` + `recipientId`) — the same shape as the `Actor`
 * abstraction (`@appstrate/connect`: `{ type: "user" | "end_user", id }`).
 * Storing the actor undistorted (rather than projecting it onto two
 * nullable `{userId, endUserId}` columns the way `runs` does) keeps the
 * recipient a single indexable tuple: one feed index instead of an
 * OR-across-two-columns bitmap, one dedup index instead of two, and no XOR
 * CHECK. It also extends to future recipient kinds (team, org, system) by
 * adding a `recipientType` value — no schema change.
 *
 * Trade-off: `recipientId` cannot carry a foreign key (it points at two
 * tables), so there is no per-recipient `ON DELETE CASCADE`. The `orgId` /
 * `applicationId` FKs still cascade (deleting an org/app drops its
 * notifications); the narrower "delete one user/end-user but keep the app"
 * case is handled by explicit cleanup at the deletion sites
 * (`deleteEndUser`, org member removal). This is the standard polymorphic
 * recipient posture — dedicated notification systems (Knock, Novu) treat
 * the recipient as an opaque external id, not a joined row.
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
    // Recipient — polymorphic. `recipientType` is the actor kind,
    // `recipientId` the actor id. Mirrors the `package_persistence`
    // convention: `text` + a TS union (the `Actor` kinds) for compile-time
    // safety + a CHECK for DB integrity — NOT a pgEnum, which the codebase
    // reserves for closed-set semantics (roles, statuses) and which would
    // need an ALTER TYPE to add a kind. No FK: the id spans two tables;
    // cleanup is explicit at the deletion sites.
    recipientType: text("recipient_type").notNull().$type<"user" | "end_user">(),
    recipientId: text("recipient_id").notNull(),
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
    // The bell only ever queries unread rows (count, unread feed, unread
    // counts-by-agent), so a single PARTIAL index keyed
    // `(org, app, recipient_type, recipient_id, created_at DESC, id DESC)
    // WHERE read_at IS NULL` backs every hot read: the (org, app, recipient)
    // prefix serves the unread count, the created_at/id tail serves the unread
    // keyset feed. The recipient is one (type, id) tuple, so this is a single
    // composite seek — no bitmap-OR.
    //
    // A non-partial twin would only serve the `unread=false` (full-history)
    // list, which has no consumer today (the bell never reads read rows). That
    // index was dropped to cut maintenance on the fan-out write path; re-add it
    // (and pair it with a retention policy) when a paged full-history feed
    // ships. Until then the rare `unread=false` call seq-scans + sorts — fine
    // at a recipient's row counts.
    index("idx_notifications_unread")
      .on(
        table.orgId,
        table.applicationId,
        table.recipientType,
        table.recipientId,
        table.createdAt.desc(),
        table.id.desc(),
      )
      .where(sql`${table.readAt} IS NULL`),
    // Backs the run_id FK ON DELETE CASCADE + by-run lookups
    // (markNotificationReadByRun).
    index("idx_notifications_run").on(table.runId),
    // Defense-in-depth against a double fan-out: at most one notification of
    // a given type per (run, recipient). The fan-out path is already
    // exactly-once (finalizeRun CAS winner), so this never fires in practice
    // — but it makes a duplicate structurally impossible if that invariant
    // ever regresses. A single index now that the recipient is one tuple.
    uniqueIndex("uq_notifications_run_recipient_type")
      .on(table.runId, table.recipientType, table.recipientId, table.type)
      .where(sql`${table.runId} IS NOT NULL`),
    // DB-level guard mirroring the `$type` union above and the
    // `pkp_actor_type_valid` CHECK on `package_persistence`. A raw insert with
    // an unknown recipient kind is rejected (the TS union only guards the ORM
    // path).
    check("notifications_recipient_type_valid", sql`recipient_type IN ('user', 'end_user')`),
  ],
);
