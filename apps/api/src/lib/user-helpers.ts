import { inArray } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { user } from "@appstrate/db/schema";

/** Batch-load user display names by ID. Returns a Map<userId, name>. */
export async function batchLoadUserNames(userIds: string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const rows = await db
    .select({ id: user.id, name: user.name })
    .from(user)
    .where(inArray(user.id, userIds));
  return new Map(rows.filter((r) => r.name).map((r) => [r.id, r.name!]));
}
