// SPDX-License-Identifier: Apache-2.0

import { inArray, sql } from "drizzle-orm";
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

/** Batch-load end-user display names (name, else external id) by ID. Returns a Map<endUserId, name>. */
export async function batchLoadEndUserNames(
  endUserIds: string[],
): Promise<Map<string, string | null>> {
  if (endUserIds.length === 0) return new Map();
  const rows = await db
    .select({
      id: endUsers.id,
      name: sql<string | null>`coalesce(${endUsers.name}, ${endUsers.externalId})`,
    })
    .from(endUsers)
    .where(inArray(endUsers.id, endUserIds));
  return new Map(rows.map((r) => [r.id, r.name]));
}
