import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packageVersionDependencies } from "@appstrate/db/schema";
import type { DepEntry } from "@appstrate/core/dependencies";

/** Batch insert version dependencies. Skips duplicates. */
export async function storeVersionDependencies(versionId: number, deps: DepEntry[]): Promise<void> {
  if (deps.length === 0) return;

  const rows = deps.map((d) => ({
    versionId,
    depScope: d.depScope,
    depName: d.depName,
    depType: d.depType,
    versionRange: d.versionRange,
  }));

  await db.insert(packageVersionDependencies).values(rows).onConflictDoNothing();
}

/** Delete all dependencies for a specific version. */
export async function clearVersionDependencies(versionId: number): Promise<void> {
  await db
    .delete(packageVersionDependencies)
    .where(eq(packageVersionDependencies.versionId, versionId));
}
