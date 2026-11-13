// SPDX-License-Identifier: Apache-2.0

import { and, eq, inArray, isNull, ne, count, desc, sql, type SQL } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  runs,
  notifications,
  organizationMembers,
  packages,
  type NotificationPayloads,
  type NotificationType,
  type PackageType,
} from "@appstrate/db/schema";
import { scopedWhere } from "../../lib/db-helpers.ts";
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

/**
 * Fan out notifications for a freshly finalized run. Called exactly once
 * per run from the `finalizeRun` CAS winner, so no dedupe is needed.
 *
 * Recipients:
 *  - run triggered by a dashboard user → that user
 *  - run triggered by an end-user      → that end-user
 *  - actor-less run (owner-less org / system schedule, where the scheduler
 *    copied a null userId+endUserId onto the run) → org admins/owners only.
 *    Owned schedules carry the owner's userId onto the run, so they hit the
 *    first branch (one notification, no fan-out). An actor-less row is readable
 *    only with `runs:read-all` (RBAC spec §3.4) — nobody else would find the
 *    run behind the bell — which is why the fan-out targets org admins, and it
 *    bounds row growth at the same time.
 *
 * Best-effort by contract: the caller wraps this in try/catch — the run is
 * already terminal, a notification write must never fail the run.
 */
export async function createRunNotifications(scope: SpaceScope, runId: string): Promise<number> {
  const [run] = await db
    .select({
      userId: runs.userId,
      endUserId: runs.endUserId,
      packageId: runs.packageId,
      status: runs.status,
      packageEphemeral: packages.ephemeral,
    })
    .from(runs)
    .leftJoin(packages, eq(packages.id, runs.packageId))
    .where(
      scopedWhere(runs, {
        orgId: scope.orgId,
        spaceId: scope.spaceId,
        extra: [eq(runs.id, runId)],
      }),
    )
    .limit(1);
  if (!run) return 0;

  // Ephemeral runs are foreground and relayed straight to their trigger (chat,
  // editor playground, direct inline API) — the result is already in front of
  // the caller, so a persistent bell notification would only duplicate it. Key
  // on the semantic `packages.ephemeral` flag rather than the `@inline/` scope
  // string: any ephemeral shadow package, whatever its scope, is foreground. A
  // null join (shadow package already compacted/deleted) defaults to notifying.
  // The run row + result still persist (recoverable in run history); only the
  // bell entry is suppressed.
  if (run.packageEphemeral === true) return 0;

  const payload: NotificationPayloads["run_completed"] = {
    packageId: run.packageId,
    status: run.status,
  };
  const base = {
    orgId: scope.orgId,
    spaceId: scope.spaceId,
    type: "run_completed" as const,
    runId,
    payload,
  };

  let rows: Array<typeof base & { recipientType: "user" | "end_user"; recipientId: string }>;
  if (run.userId) {
    rows = [{ ...base, recipientType: "user", recipientId: run.userId }];
  } else if (run.endUserId) {
    rows = [{ ...base, recipientType: "end_user", recipientId: run.endUserId }];
  } else {
    // Actor-less run → fan out to org admins/owners only.
    //
    // Bounded race: a member removed between this SELECT and the INSERT (or
    // whose run finalizes after they were removed) gets a notification they can
    // no longer see — org-context middleware blocks a non-member from reading
    // it, so it is invisible, not leaked, and is reaped when the org is
    // deleted. Re-validating membership at insert time would only narrow, not
    // close, the window (removal can still land after the INSERT), so we accept
    // the harmless orphan rather than pay for a row lock on every fan-out.
    const admins = await db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.orgId, scope.orgId),
          inArray(organizationMembers.role, ["owner", "admin"]),
        ),
      );
    rows = admins.map((m) => ({ ...base, recipientType: "user", recipientId: m.userId }));
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

// --- The feed: every kind but runs ---
//
// A finished run is a `run_completed` row of this table, but it is not part of
// the feed: the runs page lists it, with its unread dot, through the run read
// state below. The feed (the dashboard bell) serves every OTHER kind, so each
// feed read and write here excludes that one kind.

/** The kind that records a run's read state rather than a feed entry. */
const RUN_KIND = "run_completed" satisfies NotificationType;

/** The caller's own feed entries: their rows, minus the run read state. */
function feedFilter(actor: Actor): SQL[] {
  return [recipientFilter(actor), ne(notifications.type, RUN_KIND)];
}

/**
 * Mark a single feed notification read. Idempotent for the recipient
 * (already-read → still `true`); returns `false` only when the notification
 * does not exist, does not belong to the caller or is a run's read state,
 * which the route maps to `404`.
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
        extra: [eq(notifications.id, notificationId), ...feedFilter(actor)],
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
        extra: [...feedFilter(actor), isNull(notifications.readAt)],
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
        extra: [...feedFilter(actor), isNull(notifications.readAt)],
      }),
    );
  return row?.count ?? 0;
}

// --- Run read state ---
//
// Per recipient: a run is unread for the actor while their `run_completed` row
// for it has no `read_at`. Every reader of it goes through `unreadRunCondition`
// (the run's `unread` flag, a schedule's and an agent's `unread_count`, the
// `?unread=true` run filter), every writer through the two functions below.

/** The caller's own run-read-state rows. */
function runReadFilter(actor: Actor): SQL[] {
  return [recipientFilter(actor), eq(notifications.type, RUN_KIND)];
}

/**
 * Correlated predicate over `runs`: the run is unread by `actor`. The recipient
 * is matched on the polymorphic `(recipientType, recipientId)` tuple, so a
 * dashboard user and an end-user never see each other's read state.
 */
export function unreadRunCondition(actor: Actor): SQL<boolean> {
  return sql<boolean>`exists (
    select 1 from ${notifications}
    where ${notifications.runId} = ${runs.id}
      and ${recipientFilter(actor)}
      and ${notifications.type} = ${RUN_KIND}
      and ${notifications.readAt} is null
  )`;
}

/**
 * Mark a run read for the caller. Idempotent ack: a missing run or one the
 * caller holds no read state for is a no-op, not a 404.
 */
export async function markRunRead(scope: SpaceScope, runId: string, actor: Actor): Promise<void> {
  await db
    .update(notifications)
    .set({ readAt: sql`now()` })
    .where(
      scopedWhere(notifications, {
        orgId: scope.orgId,
        spaceId: scope.spaceId,
        extra: [
          eq(notifications.runId, runId),
          ...runReadFilter(actor),
          isNull(notifications.readAt),
        ],
      }),
    );
}

/** Mark every run of the space read for the caller; returns how many were unread. */
export async function markAllRunsRead(scope: SpaceScope, actor: Actor): Promise<number> {
  const updated = await db
    .update(notifications)
    .set({ readAt: sql`now()` })
    .where(
      scopedWhere(notifications, {
        orgId: scope.orgId,
        spaceId: scope.spaceId,
        extra: [...runReadFilter(actor), isNull(notifications.readAt)],
      }),
    )
    .returning({ id: notifications.id });
  return updated.length;
}

/** Unread runs per agent for the caller — the agent index's `unread_count`. */
export async function getUnreadRunCountsByAgent(
  scope: SpaceScope,
  actor: Actor,
): Promise<Record<string, number>> {
  const agentId = sql<string | null>`${notifications.payload}->>'packageId'`;
  const rows = await db
    .select({ agentId, count: count() })
    .from(notifications)
    .where(
      scopedWhere(notifications, {
        orgId: scope.orgId,
        spaceId: scope.spaceId,
        extra: [...runReadFilter(actor), isNull(notifications.readAt), sql`${agentId} IS NOT NULL`],
      }),
    )
    .groupBy(agentId);

  const result: Record<string, number> = {};
  for (const row of rows) {
    if (row.agentId) result[row.agentId] = row.count;
  }
  return result;
}

/**
 * Recipient-scoped notification feed (every kind but runs), newest first,
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
  scope: SpaceScope,
  actor: Actor,
  options: { unread?: boolean; limit?: number; startingAfter?: string } = {},
): Promise<ListEnvelope<NotificationDto>> {
  const { unread = false, startingAfter } = options;
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const fetchLimit = limit + 1; // one extra row to detect hasMore

  const extra: SQL[] = feedFilter(actor);
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
