// SPDX-License-Identifier: Apache-2.0

import { eq, or, isNotNull, isNull, count, type SQL } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { runs } from "@appstrate/db/schema";
import { scopedWhere } from "../../lib/db-helpers.ts";
import { listRunsWithFilter } from "./runs.ts";
import type { AppScope } from "../../lib/scope.ts";

// --- Notifications ---

/**
 * Build the actor ownership filter.
 * For members: filter by dashboardUserId.
 * For end-users: filter by endUserId.
 * The actorId may be a member userId or an endUserId depending on caller context.
 * We use OR to match either column, since the caller passes the correct actor ID.
 */
function actorOwnershipFilter(actorId: string): SQL {
  return or(eq(runs.dashboardUserId, actorId), eq(runs.endUserId, actorId))!;
}

export async function markNotificationRead(
  scope: AppScope,
  runId: string,
  actorId: string,
): Promise<boolean> {
  const updated = await db
    .update(runs)
    .set({ readAt: new Date() })
    .where(
      scopedWhere(runs, {
        orgId: scope.orgId,
        applicationId: scope.applicationId,
        extra: [eq(runs.id, runId), isNotNull(runs.notifiedAt), actorOrOrgFilter(actorId)],
      }),
    )
    .returning({ id: runs.id });
  return updated.length > 0;
}

/**
 * Filter: actor-owned OR org-visible runs (no dashboard user).
 * This covers:
 * - Runs triggered by the actor themselves (dashboardUserId or endUserId match)
 * - Schedule-triggered runs (no dashboardUserId, no endUserId, has scheduleId)
 * - End-user runs (no dashboardUserId, has endUserId) — visible to all org
 *   members since they are API-triggered on behalf of end-users
 */
function actorOrOrgFilter(actorId: string): SQL {
  return or(actorOwnershipFilter(actorId), isNull(runs.dashboardUserId))!;
}

export async function markAllNotificationsRead(scope: AppScope, actorId: string): Promise<number> {
  const updated = await db
    .update(runs)
    .set({ readAt: new Date() })
    .where(
      scopedWhere(runs, {
        orgId: scope.orgId,
        applicationId: scope.applicationId,
        extra: [actorOrOrgFilter(actorId), isNotNull(runs.notifiedAt), isNull(runs.readAt)],
      }),
    )
    .returning({ id: runs.id });
  return updated.length;
}

export async function getUnreadNotificationCount(
  scope: AppScope,
  actorId: string,
): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(runs)
    .where(
      scopedWhere(runs, {
        orgId: scope.orgId,
        applicationId: scope.applicationId,
        extra: [actorOrOrgFilter(actorId), isNotNull(runs.notifiedAt), isNull(runs.readAt)],
      }),
    );
  return row?.count ?? 0;
}

export async function getUnreadCountsByAgent(
  scope: AppScope,
  actorId: string,
): Promise<Record<string, number>> {
  const rows = await db
    .select({
      packageId: runs.packageId,
      count: count(),
    })
    .from(runs)
    .where(
      scopedWhere(runs, {
        orgId: scope.orgId,
        applicationId: scope.applicationId,
        extra: [
          actorOrOrgFilter(actorId),
          isNotNull(runs.notifiedAt),
          isNull(runs.readAt),
          isNotNull(runs.packageId),
        ],
      }),
    )
    .groupBy(runs.packageId);

  const result: Record<string, number> = {};
  for (const row of rows) {
    if (row.packageId) result[row.packageId] = row.count;
  }
  return result;
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
