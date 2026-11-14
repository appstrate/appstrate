// SPDX-License-Identifier: Apache-2.0

import { eq, isNull, count, desc, sql, type SQL } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import type { RunStatus } from "@appstrate/core/run-status";
import {
  notifications,
  runAlertStatusValues,
  type RunAlertStatus,
  type NotificationPayloads,
  type NotificationType,
  type PackageType,
} from "@appstrate/db/schema";
import { scopedWhere, type DbOrTx } from "../../lib/db-helpers.ts";
import { actorMatch, type Actor } from "../../lib/actor.ts";
import type { SpaceScope } from "../../lib/scope.ts";
import { listResponse } from "../../lib/list-response.ts";
import type { ListEnvelope } from "@appstrate/shared-types";

// --- Notifications ---
//
// Notifications live in their own per-recipient table (`notifications`),
// one row per recipient, with per-user read-state by construction.
// The recipient is a single polymorphic `(recipientType, recipientId)`
// tuple — the undistorted `Actor` shape. The caller's own rows are selected
// with the generic `actorMatch`, which matches both the type and the id, so
// correctness does not rest on the (unenforced) assumption that user ids and
// end-user ids never collide.

/** Match the caller's own notifications by their recipient tuple. */
function recipientFilter(actor: Actor): SQL {
  return actorMatch(actor, {
    typeCol: notifications.recipientType,
    idCol: notifications.recipientId,
  });
}

/** Shape returned to the notifications list endpoint. */
interface NotificationDto {
  id: string;
  type: NotificationType;
  runId: string | null;
  payload: NotificationPayloads[NotificationType] | null;
  read_at: string | null;
  createdAt: string;
}

function needsAttention(status: RunStatus): status is RunAlertStatus {
  return (runAlertStatusValues as readonly RunStatus[]).includes(status);
}

/**
 * Notify a finished run's recipients when it needs attention — the bell
 * decides here, when the notification is written, never when it is read.
 * Called by `recordRunFinished` (`run-reads.ts`) with the run's recipients;
 * the `(run, recipient, type)` unique index makes a re-fire a no-op.
 */
export async function notifyRunFinished(
  scope: SpaceScope,
  run: { id: string; packageId: string | null; agentName: string | null; status: RunStatus },
  recipients: Actor[],
  executor: DbOrTx,
): Promise<void> {
  const { status } = run;
  if (!needsAttention(status) || recipients.length === 0) return;
  const payload: NotificationPayloads["run_failed"] = {
    packageId: run.packageId,
    agent_name: run.agentName,
    status,
  };
  await executor
    .insert(notifications)
    .values(
      recipients.map((r) => ({
        orgId: scope.orgId,
        spaceId: scope.spaceId,
        recipientType: r.type,
        recipientId: r.id,
        type: "run_failed" as const,
        runId: run.id,
        payload,
      })),
    )
    .onConflictDoNothing();
}

/**
 * Read the caller's notification of one run (`runId`), or of every run: opening
 * a run, or reading them all, acknowledges the failure the bell showed for it.
 */
export async function markRunNotificationsRead(
  scope: SpaceScope,
  actor: Actor,
  runId?: string,
): Promise<void> {
  await db
    .update(notifications)
    .set({ readAt: sql`now()` })
    .where(
      scopedWhere(notifications, {
        orgId: scope.orgId,
        spaceId: scope.spaceId,
        extra: [
          recipientFilter(actor),
          eq(notifications.type, "run_failed"),
          isNull(notifications.readAt),
          ...(runId ? [eq(notifications.runId, runId)] : []),
        ],
      }),
    );
}

/**
 * Tell one member that a package was shared INTO a space of theirs — the
 * "user" half of `POST /api/packages/{scope}/{name}/shares` (RBAC spec §6.10).
 *
 * The notification is scoped to the TARGET space, which for a share to a person
 * is their personal space: that is where the package actually became available,
 * and the bell reads notifications of the space the recipient is in.
 *
 * No `runId` — the entity is the package, carried in the payload the way
 * it is for a run, so the bell renders without a join. The SHARER's
 * name is in there for the same reason: "X shared Y with you" is the whole
 * content of this notification, and the bell has no query that would resolve a
 * user id. Best-effort like the run fan-out: the caller wraps it, because a
 * share that succeeded must not be reported as failed because a notification
 * row would not write.
 */
export async function createPackageShareNotification(params: {
  orgId: string;
  spaceId: string;
  recipientUserId: string;
  packageId: string;
  packageType: PackageType;
  sharedByName: string;
}): Promise<void> {
  await db.insert(notifications).values({
    orgId: params.orgId,
    spaceId: params.spaceId,
    recipientType: "user",
    recipientId: params.recipientUserId,
    type: "package_shared",
    payload: {
      packageId: params.packageId,
      package_type: params.packageType,
      shared_by_name: params.sharedByName,
    },
  });
}

// --- The feed ---
//
// The bell: every notification of the caller, newest first. What reaches it was
// decided when it was written (`notifyRunFinished`, the share notice), so no
// read below filters a kind.

/**
 * Mark a single notification read. Idempotent for the recipient (already-read
 * → still `true`); returns `false` only when the notification does not exist or
 * does not belong to the caller, which the route maps to `404`.
 *
 * Single atomic UPDATE … RETURNING: `COALESCE(read_at, now())` preserves the
 * original read timestamp on a re-ack and makes an already-read row still
 * match (so it returns → `true`), while the recipient filter excludes a
 * non-caller's / missing row (zero rows → `false` → 404).
 */
export async function markNotificationRead(
  scope: SpaceScope,
  notificationId: string,
  actor: Actor,
): Promise<boolean> {
  const updated = await db
    .update(notifications)
    .set({ readAt: sql`COALESCE(${notifications.readAt}, now())` })
    .where(
      scopedWhere(notifications, {
        orgId: scope.orgId,
        spaceId: scope.spaceId,
        extra: [eq(notifications.id, notificationId), recipientFilter(actor)],
      }),
    )
    .returning({ id: notifications.id });
  return updated.length > 0;
}

export async function markAllNotificationsRead(scope: SpaceScope, actor: Actor): Promise<number> {
  const updated = await db
    .update(notifications)
    .set({ readAt: sql`now()` })
    .where(
      scopedWhere(notifications, {
        orgId: scope.orgId,
        spaceId: scope.spaceId,
        extra: [recipientFilter(actor), isNull(notifications.readAt)],
      }),
    )
    .returning({ id: notifications.id });
  return updated.length;
}

export async function getUnreadNotificationCount(scope: SpaceScope, actor: Actor): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(notifications)
    .where(
      scopedWhere(notifications, {
        orgId: scope.orgId,
        spaceId: scope.spaceId,
        extra: [recipientFilter(actor), isNull(notifications.readAt)],
      }),
    );
  return row?.count ?? 0;
}

/**
 * Recipient-scoped notification feed, newest first, keyset-paginated.
 *
 * Ordering is `(created_at DESC, id DESC)` — chronological, with `id` as the
 * unique tiebreak. The cursor (`startingAfter`) is a plain notification id;
 * its `(created_at, id)` coordinate is resolved by a scalar subquery so the
 * row-value comparison stays consistent with the ORDER BY. That keeps deep
 * pages a tight `idx_notifications_feed` range scan (no OFFSET count) and is
 * skip/duplicate-safe under concurrent inserts — a notification arriving
 * mid-pagination can never shift rows past the cursor. A stale/unknown
 * cursor resolves to NULL → empty page (the caller restarts from the head).
 */
export async function listNotifications(
  scope: SpaceScope,
  actor: Actor,
  options: { unread?: boolean; limit?: number; startingAfter?: string } = {},
): Promise<ListEnvelope<NotificationDto>> {
  const { unread = false, startingAfter } = options;
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const fetchLimit = limit + 1; // one extra row to detect hasMore

  const extra: SQL[] = [recipientFilter(actor)];
  if (unread) extra.push(isNull(notifications.readAt));
  if (startingAfter) {
    // Resolve the cursor's (created_at, id) coordinate with a scalar subquery
    // scoped to the SAME tenant + recipient as the outer query. Scoping is
    // deliberate: an unscoped lookup would (a) be a weak existence oracle for
    // notification UUIDs and (b) let a stale/foreign cursor borrow another
    // tenant's timestamp as the bound. Scoped, an unknown/foreign/stale cursor
    // resolves to NULL → the row-value comparison is NULL → empty page (the
    // caller restarts from the head), which is the correct stale-cursor result.
    extra.push(
      sql`(${notifications.createdAt}, ${notifications.id}) < ((SELECT created_at FROM notifications WHERE id = ${startingAfter} AND org_id = ${scope.orgId} AND space_id = ${scope.spaceId} AND recipient_type = ${actor.type} AND recipient_id = ${actor.id}), ${startingAfter})`,
    );
  }

  const where = scopedWhere(notifications, {
    orgId: scope.orgId,
    spaceId: scope.spaceId,
    extra,
  })!;

  const rows = await db
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
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(fetchLimit);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return listResponse(
    page.map((r) => ({
      id: r.id,
      type: r.type,
      runId: r.runId,
      payload: r.payload ?? null,
      read_at: r.readAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
    { hasMore },
  );
}
