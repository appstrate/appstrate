// SPDX-License-Identifier: Apache-2.0

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { endUsers, schedules, user } from "@appstrate/db/schema";

/** Batch-load user display names by ID. Returns a Map<userId, name>. */
export async function batchLoadUserNames(userIds: string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const rows = await db
    .select({ id: user.id, name: user.name })
    .from(user)
    .where(inArray(user.id, userIds));
  return new Map(rows.filter((r) => r.name).map((r) => [r.id, r.name!]));
}

/** Resolve each schedule's end-user in the organization and space where it runs. */
export async function batchLoadScheduleEndUserNames(
  orgId: string,
  rows: readonly { id: string; endUserId: string | null }[],
): Promise<Map<string, string | null>> {
  const ids = rows.filter((row) => row.endUserId).map((row) => row.id);
  if (ids.length === 0) return new Map();
  const names = await db
    .select({
      id: schedules.id,
      name: sql<string | null>`coalesce(${endUsers.name}, ${endUsers.externalId})`,
    })
    .from(schedules)
    .innerJoin(
      endUsers,
      and(
        eq(endUsers.id, schedules.endUserId),
        eq(endUsers.spaceId, schedules.spaceId),
        eq(endUsers.orgId, schedules.orgId),
      ),
    )
    .where(and(eq(schedules.orgId, orgId), inArray(schedules.id, ids)));
  return new Map(names.map((row) => [row.id, row.name]));
}
