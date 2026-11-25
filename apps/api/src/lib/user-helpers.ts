// SPDX-License-Identifier: Apache-2.0

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { endUsers, user } from "@appstrate/db/schema";

/** Batch-load user display names by ID. Returns a Map<userId, name>. */
export async function batchLoadUserNames(userIds: string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const rows = await db
    .select({ id: user.id, name: user.name })
    .from(user)
    .where(inArray(user.id, userIds));
  return new Map(rows.filter((r) => r.name).map((r) => [r.id, r.name!]));
}

/** Resolve names for the actor and space captured in the schedule read. */
export async function batchLoadScheduleEndUserNames(
  orgId: string,
  rows: readonly { id: string; spaceId: string; endUserId: string | null }[],
): Promise<Map<string, string | null>> {
  const actors = rows.flatMap(({ id, spaceId, endUserId }) =>
    endUserId ? [{ id, spaceId, endUserId }] : [],
  );
  if (!actors.length) return new Map();
  const names = await db
    .select({
      id: endUsers.id,
      spaceId: endUsers.spaceId,
      name: sql<string | null>`coalesce(${endUsers.name}, ${endUsers.externalId})`,
    })
    .from(endUsers)
    .where(
      and(
        eq(endUsers.orgId, orgId),
        inArray(endUsers.spaceId, [...new Set(actors.map((a) => a.spaceId))]),
        inArray(endUsers.id, [...new Set(actors.map((a) => a.endUserId))]),
      ),
    );
  const byId = new Map(names.map((row) => [row.id, row]));
  return new Map(
    actors.map(({ id, spaceId, endUserId }) => {
      const actor = byId.get(endUserId);
      return [id, actor?.spaceId === spaceId ? actor.name : null];
    }),
  );
}
