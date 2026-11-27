// SPDX-License-Identifier: Apache-2.0

import { and, eq, inArray, isNull, count, desc, sql, type SQL } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { toPgSafe } from "@appstrate/db/pg-safe";
import type { RunStatus } from "@appstrate/core/run-status";
import {
  notifications,
  runAlertStatusValues,
  type RunAlertStatus,
  type NotificationPayloads,
  type NotificationType,
  type PackageType,
} from "@appstrate/db/schema";
import { isUuid, scopedWhere, type DbOrTx } from "../../lib/db-helpers.ts";
import { actorMatch, type Actor } from "../../lib/actor.ts";
import type { SpaceScope, SpacesScope } from "../../lib/scope.ts";
import { listResponse } from "@appstrate/core/list-query";
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
  /** The space it was written in: where its page and its run open. */
  spaceId: string;
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
 * Write the notification an agent sends from inside its run (`notify`, a tool
 * of `@appstrate/platform`), one row per recipient of the run
 * (`resolveRunRecipients`, the same people its read state and failure notice
 * go to).
 *
 * Each recipient receives at most one `agent_message` per run: the
 * `(run, recipient, type)` unique index makes a second call a no-op. Returns how
 * many rows were written; `0` means the run already sent its message. `recipients`
 * is not empty.
 */
export async function createAgentMessageNotifications(
  scope: SpaceScope,
  run: { id: string; packageId: string | null; agentName: string | null },
  recipients: Actor[],
  message: { title: string; message: string },
): Promise<number> {
  const payload: NotificationPayloads["agent_message"] = toPgSafe({
    packageId: run.packageId,
    agent_name: run.agentName,
    title: message.title,
    message: message.message,
  });
  const inserted = await db
    .insert(notifications)
    .values(
      recipients.map((r) => ({
        orgId: scope.orgId,
        spaceId: scope.spaceId,
        recipientType: r.type,
        recipientId: r.id,
        type: "agent_message" as const,
        runId: run.id,
        payload,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: notifications.id });
  return inserted.length;
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

/**
 * Writes one `integration_tools_review` notice per recipient in `spaceId`; the partial unique
 * index (one unread notice per space, recipient and integration) absorbs the rest. Who to ask, and
 * whether to, is `services/integration-tool-review.ts`'s judgement.
 */
export async function insertToolReviewNotifications(params: {
  orgId: string;
  spaceId: string;
  recipientUserIds: readonly string[];
  payload: NotificationPayloads["integration_tools_review"];
}): Promise<void> {
  if (params.recipientUserIds.length === 0) return;
  await db
    .insert(notifications)
    .values(
      params.recipientUserIds.map((userId) => ({
        orgId: params.orgId,
        spaceId: params.spaceId,
        recipientType: "user" as const,
        recipientId: userId,
        type: "integration_tools_review" as const,
        payload: params.payload,
      })),
    )
    .onConflictDoNothing();
}

/**
 * Tell a connection's owner that it died. No dedup index: one announcement per flip, and there is
 * no `runId`. Model-provider credentials write no row here: who receives it is undecided (#1310).
 */
export async function createCredentialNeedsReconnectionNotification(params: {
  orgId: string;
  spaceId: string;
  recipient: Actor;
  payload: NotificationPayloads["credential_needs_reconnection"];
}): Promise<void> {
  await db.insert(notifications).values({
    orgId: params.orgId,
    spaceId: params.spaceId,
    recipientType: params.recipient.type,
    recipientId: params.recipient.id,
    type: "credential_needs_reconnection",
    payload: toPgSafe(params.payload),
  });
}

/**
 * Tell a connection's owner that a server asked it for scopes it does not hold. The partial unique
 * index keeps one unread notice per (recipient, connection): the rest is absorbed.
 */
export async function createScopesRequestedNotification(params: {
  orgId: string;
  spaceId: string;
  recipient: Actor;
  payload: NotificationPayloads["connection_scopes_requested"];
}): Promise<void> {
  await db
    .insert(notifications)
    .values({
      orgId: params.orgId,
      spaceId: params.spaceId,
      recipientType: params.recipient.type,
      recipientId: params.recipient.id,
      type: "connection_scopes_requested",
      payload: toPgSafe(params.payload),
    })
    .onConflictDoNothing();
}

// --- The feed ---
//
// The bell: every notification of the caller, newest first. What reaches it was
// decided when it was written (`notifyRunFinished`, the share notice), so no
// read below filters a kind.

const notificationColumns = {
  id: notifications.id,
  spaceId: notifications.spaceId,
  type: notifications.type,
  runId: notifications.runId,
  payload: notifications.payload,
  readAt: notifications.readAt,
  createdAt: notifications.createdAt,
};

function toNotificationDto(
  r: Pick<typeof notifications.$inferSelect, keyof typeof notificationColumns>,
): NotificationDto {
  return {
    id: r.id,
    spaceId: r.spaceId,
    type: r.type,
    runId: r.runId,
    payload: r.payload ?? null,
    read_at: r.readAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

/**
 * One notification of the caller in the spaces of `reach`; `null` when it is
 * unknown, another's or outside them (the route's 404).
 */
export async function getNotification(
  reach: SpacesScope,
  notificationId: string,
  actor: Actor,
): Promise<NotificationDto | null> {
  if (reach.spaceIds.length === 0 || !isUuid(notificationId)) return null;
  const [row] = await db
    .select(notificationColumns)
    .from(notifications)
    .where(feedWhere(reach, actor, [eq(notifications.id, notificationId)]))
    .limit(1);
  return row ? toNotificationDto(row) : null;
}

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
  if (!isUuid(notificationId)) return false;
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

/**
 * The caller's notifications in the spaces of `reach`. Every reader answers a
 * reach of no space before building it: an empty `IN ()` is no filter here.
 */
function feedWhere(reach: SpacesScope, actor: Actor, extra: SQL[] = []): SQL {
  return and(
    eq(notifications.orgId, reach.orgId),
    inArray(notifications.spaceId, [...reach.spaceIds]),
    recipientFilter(actor),
    ...extra,
  )!;
}

export async function getUnreadNotificationCount(
  reach: SpacesScope,
  actor: Actor,
): Promise<number> {
  if (reach.spaceIds.length === 0) return 0;
  const [row] = await db
    .select({ count: count() })
    .from(notifications)
    .where(feedWhere(reach, actor, [isNull(notifications.readAt)]));
  return row?.count ?? 0;
}

/**
 * Recipient-scoped notification feed over the spaces of `reach`, newest first,
 * keyset-paginated.
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
  reach: SpacesScope,
  actor: Actor,
  options: { unread?: boolean; limit: number; startingAfter?: string },
): Promise<ListEnvelope<NotificationDto>> {
  const { unread = false, limit, startingAfter } = options;
  const fetchLimit = limit + 1; // one extra row to detect hasMore

  // No space, or not an id at all (a cursor no row has, so the empty page a stale one gets).
  if (reach.spaceIds.length === 0 || (startingAfter && !isUuid(startingAfter))) {
    return listResponse([], { hasMore: false });
  }

  const extra: SQL[] = [];
  if (unread) extra.push(isNull(notifications.readAt));
  if (startingAfter) {
    // The cursor's (created_at, id) coordinate, looked up within the SAME
    // reach and recipient as the page: an unscoped lookup would be a weak
    // existence oracle for notification ids and let a foreign cursor borrow
    // another tenant's timestamp. Unknown, foreign or stale, it resolves to
    // NULL → the comparison is NULL → empty page.
    const cursor = db
      .select({ createdAt: notifications.createdAt })
      .from(notifications)
      .where(feedWhere(reach, actor, [eq(notifications.id, startingAfter)]));
    extra.push(
      sql`(${notifications.createdAt}, ${notifications.id}) < ((${cursor}), ${startingAfter})`,
    );
  }

  const rows = await db
    .select(notificationColumns)
    .from(notifications)
    .where(feedWhere(reach, actor, extra))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(fetchLimit);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return listResponse(page.map(toNotificationDto), { hasMore });
}
