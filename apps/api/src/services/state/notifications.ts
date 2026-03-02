import { eq, and, isNotNull, isNull, desc, count } from "drizzle-orm";
import { db } from "../../lib/db.ts";
import { executions } from "@appstrate/db/schema";

// --- Notifications ---

export async function markNotificationRead(
  executionId: string,
  userId: string,
  orgId: string,
): Promise<boolean> {
  const updated = await db
    .update(executions)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(executions.id, executionId),
        eq(executions.userId, userId),
        eq(executions.orgId, orgId),
        isNotNull(executions.notifiedAt),
      ),
    )
    .returning({ id: executions.id });
  return updated.length > 0;
}

export async function markAllNotificationsRead(userId: string, orgId: string): Promise<number> {
  const updated = await db
    .update(executions)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(executions.userId, userId),
        eq(executions.orgId, orgId),
        isNotNull(executions.notifiedAt),
        isNull(executions.readAt),
      ),
    )
    .returning({ id: executions.id });
  return updated.length;
}

export async function getUnreadNotificationCount(userId: string, orgId: string): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(executions)
    .where(
      and(
        eq(executions.userId, userId),
        eq(executions.orgId, orgId),
        isNotNull(executions.notifiedAt),
        isNull(executions.readAt),
      ),
    );
  return row?.count ?? 0;
}

export async function listUserExecutions(
  userId: string,
  orgId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<{ executions: Record<string, unknown>[]; total: number }> {
  const limit = options.limit ?? 20;
  const offset = options.offset ?? 0;

  const [countRow] = await db
    .select({ count: count() })
    .from(executions)
    .where(and(eq(executions.userId, userId), eq(executions.orgId, orgId)));

  const rows = await db
    .select()
    .from(executions)
    .where(and(eq(executions.userId, userId), eq(executions.orgId, orgId)))
    .orderBy(desc(executions.startedAt))
    .limit(limit)
    .offset(offset);

  return { executions: rows as unknown as Record<string, unknown>[], total: countRow?.count ?? 0 };
}
