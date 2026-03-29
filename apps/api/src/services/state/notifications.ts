import { eq, and, or, isNotNull, isNull, desc, count, type SQL } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { executions, packageVersions } from "@appstrate/db/schema";

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

export async function listUserExecutions(
  actorId: string,
  orgId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<{ executions: Record<string, unknown>[]; total: number }> {
  const limit = options.limit ?? 20;
  const offset = options.offset ?? 0;

  const [countRow] = await db
    .select({ count: count() })
    .from(executions)
    .where(and(actorOrOrgFilter(actorId), eq(executions.orgId, orgId)));

  const rows = await db
    .select({
      execution: executions,
      packageVersion: packageVersions.version,
    })
    .from(executions)
    .leftJoin(packageVersions, eq(executions.packageVersionId, packageVersions.id))
    .where(and(actorOrOrgFilter(actorId), eq(executions.orgId, orgId)))
    .orderBy(desc(executions.startedAt))
    .limit(limit)
    .offset(offset);

  const mapped = rows.map((r) => ({ ...r.execution, packageVersion: r.packageVersion }));
  return {
    executions: mapped as unknown as Record<string, unknown>[],
    total: countRow?.count ?? 0,
  };
}
