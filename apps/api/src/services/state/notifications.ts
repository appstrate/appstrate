import { eq, and, or, isNotNull, isNull, count, type SQL } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { executions } from "@appstrate/db/schema";
import { listExecutionsWithFilter } from "./executions.ts";

// --- Notifications ---

/**
 * Build the actor ownership filter.
 * For members: filter by userId.
 * For end-users: filter by endUserId.
 * The actorId may be a member userId or an endUserId depending on caller context.
 * We use OR to match either column, since the caller passes the correct actor ID.
 */
function actorOwnershipFilter(actorId: string): SQL {
  return or(eq(executions.userId, actorId), eq(executions.endUserId, actorId))!;
}

export async function markNotificationRead(
  executionId: string,
  actorId: string,
  orgId: string,
): Promise<boolean> {
  const updated = await db
    .update(executions)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(executions.id, executionId),
        eq(executions.orgId, orgId),
        isNotNull(executions.notifiedAt),
        actorOrOrgFilter(actorId),
      ),
    )
    .returning({ id: executions.id });
  return updated.length > 0;
}

/**
 * Filter: actor-owned OR schedule-triggered org-level executions (no actor).
 * Org-level executions come from schedules bound to org profiles — they have
 * no userId/endUserId but do have a scheduleId. All org members can see them.
 */
function actorOrOrgFilter(actorId: string): SQL {
  return or(
    actorOwnershipFilter(actorId),
    and(isNull(executions.userId), isNull(executions.endUserId), isNotNull(executions.scheduleId)),
  )!;
}

export async function markAllNotificationsRead(actorId: string, orgId: string): Promise<number> {
  const updated = await db
    .update(executions)
    .set({ readAt: new Date() })
    .where(
      and(
        actorOrOrgFilter(actorId),
        eq(executions.orgId, orgId),
        isNotNull(executions.notifiedAt),
        isNull(executions.readAt),
      ),
    )
    .returning({ id: executions.id });
  return updated.length;
}

export async function getUnreadNotificationCount(actorId: string, orgId: string): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(executions)
    .where(
      and(
        actorOrOrgFilter(actorId),
        eq(executions.orgId, orgId),
        isNotNull(executions.notifiedAt),
        isNull(executions.readAt),
      ),
    );
  return row?.count ?? 0;
}

export async function getUnreadCountsByFlow(
  actorId: string,
  orgId: string,
): Promise<Record<string, number>> {
  const rows = await db
    .select({
      packageId: executions.packageId,
      count: count(),
    })
    .from(executions)
    .where(
      and(
        actorOrOrgFilter(actorId),
        eq(executions.orgId, orgId),
        isNotNull(executions.notifiedAt),
        isNull(executions.readAt),
        isNotNull(executions.packageId),
      ),
    )
    .groupBy(executions.packageId);

  const result: Record<string, number> = {};
  for (const row of rows) {
    if (row.packageId) result[row.packageId] = row.count;
  }
  return result;
}

export async function listOrgExecutions(
  orgId: string,
  options: { limit?: number; offset?: number } = {},
) {
  const { limit = 20, offset = 0 } = options;
  return listExecutionsWithFilter(eq(executions.orgId, orgId), limit, offset);
}

export async function listUserExecutions(
  actorId: string,
  orgId: string,
  options: { limit?: number; offset?: number } = {},
) {
  const { limit = 20, offset = 0 } = options;
  return listExecutionsWithFilter(
    and(actorOrOrgFilter(actorId), eq(executions.orgId, orgId))!,
    limit,
    offset,
  );
}
