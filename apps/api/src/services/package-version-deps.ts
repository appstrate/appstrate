// SPDX-License-Identifier: Apache-2.0

import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packageVersionDependencies } from "@appstrate/db/schema";
import type { DepEntry } from "@appstrate/core/dependencies";

/**
 * A Drizzle executor — either the root `db` or an open transaction handle.
 * Lets callers run dependency-index writes inside the same transaction that
 * inserts the version row, so the row and its derived index commit (or roll
 * back) atomically.
 */
type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Batch insert version dependencies. Skips duplicates. */
export async function storeVersionDependencies(
  versionId: number,
  deps: DepEntry[],
  executor: DbOrTx = db,
): Promise<void> {
  if (deps.length === 0) return;

  const rows = deps.map((d) => ({
    versionId,
    depScope: d.depScope,
    depName: d.depName,
    depType: d.depType,
    versionRange: d.versionRange,
  }));

  await executor.insert(packageVersionDependencies).values(rows).onConflictDoNothing();
}

/** Delete all dependencies for a specific version. */
export async function clearVersionDependencies(
  versionId: number,
  executor: DbOrTx = db,
): Promise<void> {
  await executor
    .delete(packageVersionDependencies)
    .where(eq(packageVersionDependencies.versionId, versionId));
}
