// SPDX-License-Identifier: Apache-2.0

import { eq, and, or, isNotNull, isNull, count, type SQL } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { runs } from "@appstrate/db/schema";
import { listRunsWithFilter } from "./runs.ts";

// --- Notifications ---

/**
 * Build the actor ownership filter.
 * For members: filter by userId.
 * For end-users: filter by endUserId.
 * The actorId may be a member userId or an endUserId depending on caller context.
 * We use OR to match either column, since the caller passes the correct actor ID.
 */
function actorOwnershipFilter(actorId: string): SQL {
  return or(eq(runs.userId, actorId), eq(runs.endUserId, actorId))!;
}

export async function markNotificationRead(
  runId: string,
  actorId: string,
  orgId: string,
  applicationId: string,
): Promise<boolean> {
  const updated = await db
    .update(runs)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(runs.id, runId),
        eq(runs.orgId, orgId),
        eq(runs.applicationId, applicationId),
        isNotNull(runs.notifiedAt),
        actorOrOrgFilter(actorId),
      ),
    )
    .returning({ id: runs.id });
  return updated.length > 0;
}

/**
 * Filter: actor-owned OR schedule-triggered org-level runs (no actor).
 * Org-level runs come from schedules bound to org profiles — they have
 * no userId/endUserId but do have a scheduleId. All org members can see them.
 */
function actorOrOrgFilter(actorId: string): SQL {
  return or(
    actorOwnershipFilter(actorId),
    and(isNull(runs.userId), isNull(runs.endUserId), isNotNull(runs.scheduleId)),
  )!;
}

export async function markAllNotificationsRead(
  actorId: string,
  orgId: string,
  applicationId: string,
): Promise<number> {
  const updated = await db
    .update(runs)
    .set({ readAt: new Date() })
    .where(
      and(
        actorOrOrgFilter(actorId),
        eq(runs.orgId, orgId),
        eq(runs.applicationId, applicationId),
        isNotNull(runs.notifiedAt),
        isNull(runs.readAt),
      ),
    )
    .returning({ id: runs.id });
  return updated.length;
}

export async function getUnreadNotificationCount(
  actorId: string,
  orgId: string,
  applicationId: string,
): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(runs)
    .where(
      and(
        actorOrOrgFilter(actorId),
        eq(runs.orgId, orgId),
        eq(runs.applicationId, applicationId),
        isNotNull(runs.notifiedAt),
        isNull(runs.readAt),
      ),
    );
  return row?.count ?? 0;
}

export async function getUnreadCountsByAgent(
  actorId: string,
  orgId: string,
  applicationId: string,
): Promise<Record<string, number>> {
  const rows = await db
    .select({
      packageId: runs.packageId,
      count: count(),
    })
    .from(runs)
    .where(
      and(
        actorOrOrgFilter(actorId),
        eq(runs.orgId, orgId),
        eq(runs.applicationId, applicationId),
        isNotNull(runs.notifiedAt),
        isNull(runs.readAt),
        isNotNull(runs.packageId),
      ),
    )
    .groupBy(runs.packageId);

  const result: Record<string, number> = {};
  for (const row of rows) {
    if (row.packageId) result[row.packageId] = row.count;
  }
  return result;
}

export async function listOrgRuns(
  orgId: string,
  options: { limit?: number; offset?: number; applicationId: string },
) {
  const { limit = 20, offset = 0, applicationId } = options;
  return listRunsWithFilter(
    and(eq(runs.orgId, orgId), eq(runs.applicationId, applicationId))!,
    limit,
    offset,
  );
}

export async function listUserRuns(
  actorId: string,
  orgId: string,
  options: { limit?: number; offset?: number; applicationId: string },
) {
  const { limit = 20, offset = 0, applicationId } = options;
  return listRunsWithFilter(
    and(actorOrOrgFilter(actorId), eq(runs.orgId, orgId), eq(runs.applicationId, applicationId))!,
    limit,
    offset,
  );
}
