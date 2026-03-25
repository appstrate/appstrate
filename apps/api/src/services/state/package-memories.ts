import { eq, and, asc, count } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packageMemories } from "@appstrate/db/schema";

// --- Package Memories (org-scoped, accumulate across executions) ---

export const MAX_MEMORY_CONTENT = 2000;
export const MAX_MEMORIES_PER_PACKAGE = 100;

export async function getPackageMemories(packageId: string, orgId: string) {
  return db
    .select()
    .from(packageMemories)
    .where(and(eq(packageMemories.packageId, packageId), eq(packageMemories.orgId, orgId)))
    .orderBy(asc(packageMemories.createdAt));
}

export async function addPackageMemories(
  packageId: string,
  orgId: string,
  contents: string[],
  executionId: string,
): Promise<number> {
  // Count existing memories
  const [row] = await db
    .select({ count: count() })
    .from(packageMemories)
    .where(and(eq(packageMemories.packageId, packageId), eq(packageMemories.orgId, orgId)));
  const existing = row?.count ?? 0;
  const available = Math.max(0, MAX_MEMORIES_PER_PACKAGE - existing);
  if (available === 0) return 0;

  const toInsert = contents
    .slice(0, available)
    .map((c) => c.slice(0, MAX_MEMORY_CONTENT))
    .map((content) => ({ packageId, orgId, content, executionId }));

  if (toInsert.length === 0) return 0;

  const inserted = await db
    .insert(packageMemories)
    .values(toInsert)
    .returning({ id: packageMemories.id });
  return inserted.length;
}

export async function deletePackageMemory(
  id: number,
  packageId: string,
  orgId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(packageMemories)
    .where(
      and(
        eq(packageMemories.id, id),
        eq(packageMemories.packageId, packageId),
        eq(packageMemories.orgId, orgId),
      ),
    )
    .returning({ id: packageMemories.id });
  return deleted.length > 0;
}

export async function deleteAllPackageMemories(packageId: string, orgId: string): Promise<number> {
  const deleted = await db
    .delete(packageMemories)
    .where(and(eq(packageMemories.packageId, packageId), eq(packageMemories.orgId, orgId)))
    .returning({ id: packageMemories.id });
  return deleted.length;
}
