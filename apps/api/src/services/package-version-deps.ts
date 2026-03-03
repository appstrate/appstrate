import { eq } from "drizzle-orm";
import { db } from "../lib/db.ts";
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

/** Get all dependencies for a specific version. */
export async function getVersionDependencies(versionId: number): Promise<DepEntry[]> {
  const rows = await db
    .select({
      depScope: packageVersionDependencies.depScope,
      depName: packageVersionDependencies.depName,
      depType: packageVersionDependencies.depType,
      versionRange: packageVersionDependencies.versionRange,
    })
    .from(packageVersionDependencies)
    .where(eq(packageVersionDependencies.versionId, versionId));

  // Safe: extractDependencies() only produces "skill" | "extension" deps
  return rows as DepEntry[];
}
