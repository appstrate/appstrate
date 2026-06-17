// SPDX-License-Identifier: Apache-2.0

import { and, eq, or, inArray, isNull, isNotNull, count, desc, sql, type SQL } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { runs, notifications, organizationMembers } from "@appstrate/db/schema";
import { scopedWhere } from "../../lib/db-helpers.ts";
import { listRunsWithFilter } from "./runs.ts";
import type { AppScope } from "../../lib/scope.ts";

// --- Notifications ---
//
// Notifications live in their own per-recipient table (`notifications`),
// one row per recipient, with per-user read-state by construction (issue
// #667). The recipient is identified by the same nullable
// `{userId, endUserId}` pair used everywhere else; an actor id matches at
// most one of the two columns (user ids are UUID-ish, end-user ids carry
// the `eu_` prefix — they never collide), so a single OR filter scopes a
// query to the caller's own notifications without needing the actor type.

/** Match the caller's own notifications by recipient column (user OR end-user). */
function recipientFilter(actorId: string): SQL {
  return or(eq(notifications.userId, actorId), eq(notifications.endUserId, actorId))!;
}

/** Shape returned to the notifications list endpoint. */
export interface NotificationDto {
  id: string;
  type: string;
  run_id: string | null;
  payload: Record<string, unknown> | null;
  read_at: string | null;
  created_at: string;
}

export interface NotificationListResult {
  data: NotificationDto[];
  total: number;
}

/**
 * Fan out notifications for a freshly finalized run. Called exactly once
 * per run from the `finalizeRun` CAS winner, so no dedupe is needed.
 *
 * Recipients (issue #667):
 *  - run triggered by a dashboard user → that user
 *  - run triggered by an end-user      → that end-user
 *  - actor-less run (owner-less org / system schedule, where the scheduler
 *    copied a null userId+endUserId onto the run) → org admins/owners only.
 *    Owned schedules carry the owner's userId onto the run, so they hit the
 *    first branch (one notification, no fan-out). Restricting the actor-less
 *    case to admins bounds row growth and avoids bell-spamming every member
 *    for a schedule nobody personally owns; plain members still see the run
 *    in the runs list.
 *
 * Best-effort by contract: the caller wraps this in try/catch — the run is
 * already terminal, a notification write must never fail the run.
 */
export async function createRunNotifications(scope: AppScope, runId: string): Promise<number> {
  const [run] = await db
    .select({
      userId: runs.userId,
      endUserId: runs.endUserId,
      packageId: runs.packageId,
      status: runs.status,
    })
    .from(runs)
    .where(and(eq(runs.id, runId), eq(runs.orgId, scope.orgId)))
    .limit(1);
  if (!run) return 0;

  const payload = { agent_id: run.packageId, status: run.status };
  const base = {
    orgId: scope.orgId,
    applicationId: scope.applicationId,
    type: "run_completed",
    runId,
    payload,
  };

  let rows: Array<typeof base & { userId?: string; endUserId?: string }>;
  if (run.userId) {
    rows = [{ ...base, userId: run.userId }];
  } else if (run.endUserId) {
    rows = [{ ...base, endUserId: run.endUserId }];
  } else {
    // Actor-less run → fan out to org admins/owners only.
    const admins = await db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.orgId, scope.orgId),
          inArray(organizationMembers.role, ["owner", "admin"]),
        ),
      );
    rows = admins.map((m) => ({ ...base, userId: m.userId }));
  }

  if (rows.length === 0) return 0;
  // onConflictDoNothing: a re-fire (the CAS should prevent it, but be safe)
  // collides with the (run_id, recipient, type) unique indexes and is a no-op
  // rather than an error. Return the count actually inserted.
  const inserted = await db
    .insert(notifications)
    .values(rows)
    .onConflictDoNothing()
    .returning({ id: notifications.id });
  return inserted.length;
}

/**
 * Transition dual-write (#667): the run-list and schedule-card surfaces still
 * derive their "unread" badge from the legacy global `runs.readAt` flag.
 * Mirror the per-recipient mark onto it so those surfaces clear until they are
 * migrated onto the notifications table (removed in the follow-up that drops
 * `runs.notifiedAt` / `runs.readAt`). Scoped to runs the actor can see, only
 * those already notified and still unread — a verbatim port of the pre-#667
 * mark queries. Best-effort relative to the authoritative notifications write.
 */
async function legacyMarkRunsRead(scope: AppScope, actorId: string, runId?: string): Promise<void> {
  await db
    .update(runs)
    .set({ readAt: new Date() })
    .where(
      scopedWhere(runs, {
        orgId: scope.orgId,
        applicationId: scope.applicationId,
        extra: [
          ...(runId ? [eq(runs.id, runId)] : []),
          actorOrOrgFilter(actorId),
          isNotNull(runs.notifiedAt),
          isNull(runs.readAt),
        ],
      }),
    );
}

/**
 * Mark a single notification read. Idempotent for the recipient (already-read
 * → still `true`); returns `false` only when the notification does not exist
 * or does not belong to the caller, which the route maps to `404`.
 *
 * Single atomic UPDATE … RETURNING: `COALESCE(read_at, now())` preserves the
 * original read timestamp on a re-ack and makes an already-read row still
 * match (so it returns → `true`), while the recipient filter excludes a
 * non-caller's / missing row (zero rows → `false` → 404). This avoids the
 * former UPDATE-then-SELECT, whose two non-atomic statements could return a
 * spurious 404 if a concurrent run-delete cascaded the row away between them.
 */
export async function markNotificationRead(
  scope: AppScope,
  notificationId: string,
  actorId: string,
): Promise<boolean> {
  const where = scopedWhere(notifications, {
    orgId: scope.orgId,
    applicationId: scope.applicationId,
    extra: [eq(notifications.id, notificationId), recipientFilter(actorId)],
  })!;

  const updated = await db
    .update(notifications)
    .set({ readAt: sql`COALESCE(${notifications.readAt}, now())` })
    .where(where)
    .returning({ id: notifications.id, runId: notifications.runId });
  if (updated.length === 0) return false;

  const runId = updated[0]!.runId;
  if (runId) await legacyMarkRunsRead(scope, actorId, runId);
  return true;
}

/**
 * Mark the caller's notification(s) for a run read, keyed by run id rather
 * than notification id. First-class convenience for callers that hold a run
 * id but not the notification id — the run-detail page marks the run's
 * notification read on open. Idempotent ack: never errors on a missing run
 * or non-recipient (nothing to mark is a no-op, not a 404).
 */
export async function markNotificationReadByRun(
  scope: AppScope,
  runId: string,
  actorId: string,
): Promise<void> {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      scopedWhere(notifications, {
        orgId: scope.orgId,
        applicationId: scope.applicationId,
        extra: [
          eq(notifications.runId, runId),
          recipientFilter(actorId),
          isNull(notifications.readAt),
        ],
      }),
    );
  await legacyMarkRunsRead(scope, actorId, runId);
}

export async function markAllNotificationsRead(scope: AppScope, actorId: string): Promise<number> {
  const updated = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      scopedWhere(notifications, {
        orgId: scope.orgId,
        applicationId: scope.applicationId,
        extra: [recipientFilter(actorId), isNull(notifications.readAt)],
      }),
    )
    .returning({ id: notifications.id });
  await legacyMarkRunsRead(scope, actorId);
  return updated.length;
}

export async function getUnreadNotificationCount(
  scope: AppScope,
  actorId: string,
): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(notifications)
    .where(
      scopedWhere(notifications, {
        orgId: scope.orgId,
        applicationId: scope.applicationId,
        extra: [recipientFilter(actorId), isNull(notifications.readAt)],
      }),
    );
  return row?.count ?? 0;
}

export async function getUnreadCountsByAgent(
  scope: AppScope,
  actorId: string,
): Promise<Record<string, number>> {
  const agentId = sql<string | null>`${notifications.payload}->>'agent_id'`;
  const rows = await db
    .select({ agentId, count: count() })
    .from(notifications)
    .where(
      scopedWhere(notifications, {
        orgId: scope.orgId,
        applicationId: scope.applicationId,
        extra: [
          recipientFilter(actorId),
          isNull(notifications.readAt),
          sql`${agentId} IS NOT NULL`,
        ],
      }),
    )
    .groupBy(agentId);

  const result: Record<string, number> = {};
  for (const row of rows) {
    if (row.agentId) result[row.agentId] = row.count;
  }
  return result;
}

export async function listNotifications(
  scope: AppScope,
  actorId: string,
  options: { unread?: boolean; limit?: number; offset?: number } = {},
): Promise<NotificationListResult> {
  const { unread = false, limit = 20, offset = 0 } = options;
  const where = scopedWhere(notifications, {
    orgId: scope.orgId,
    applicationId: scope.applicationId,
    extra: [recipientFilter(actorId), ...(unread ? [isNull(notifications.readAt)] : [])],
  })!;

  const [rows, [totalRow]] = await Promise.all([
    db
      .select({
        id: notifications.id,
        type: notifications.type,
        runId: notifications.runId,
        payload: notifications.payload,
        readAt: notifications.readAt,
        createdAt: notifications.createdAt,
      })
      .from(notifications)
      .where(where)
      .orderBy(desc(notifications.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ count: count() }).from(notifications).where(where),
  ]);

  return {
    data: rows.map((r) => ({
      id: r.id,
      type: r.type,
      run_id: r.runId,
      payload: r.payload ?? null,
      read_at: r.readAt?.toISOString() ?? null,
      created_at: r.createdAt.toISOString(),
    })),
    total: totalRow?.count ?? 0,
  };
}

// --- Run list (GET /api/runs?user=me) ---
//
// Unrelated to notifications, but the handler shares this module. The
// "my runs" view keeps the original actor-or-org-visible semantics.

function actorOwnershipFilter(actorId: string): SQL {
  return or(eq(runs.userId, actorId), eq(runs.endUserId, actorId))!;
}

/**
 * Filter: actor-owned OR org-visible runs (no dashboard user) — covers
 * self-triggered runs, schedule-triggered runs, and end-user runs.
 */
function actorOrOrgFilter(actorId: string): SQL {
  return or(actorOwnershipFilter(actorId), isNull(runs.userId))!;
}

export async function listUserRuns(
  scope: AppScope,
  actorId: string,
  options: { limit?: number; offset?: number } = {},
) {
  const { limit = 20, offset = 0 } = options;
  return listRunsWithFilter(
    scopedWhere(runs, {
      orgId: scope.orgId,
      applicationId: scope.applicationId,
      extra: [actorOrOrgFilter(actorId)],
    })!,
    limit,
    offset,
  );
}
