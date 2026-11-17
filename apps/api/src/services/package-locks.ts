// SPDX-License-Identifier: Apache-2.0

/**
 * The two per-package advisory locks, and the storage key each one guards.
 *
 * Package object keys are derived from the package id alone, so the key a
 * deleted package (or version) leaves behind is the key its successor under
 * the same id writes. Bytes are uploaded only for a row already committed, or
 * for one that commits under this lock, and the storage-deletion worker takes
 * the same lock before deciding a key is dead (`deleteUnlessReclaimed`).
 * Changing either lock key here changes it for both sides at once — which is
 * the point.
 */

import { sql } from "drizzle-orm";
import { db, type Db } from "@appstrate/db/client";
import type { DbOrTx } from "../lib/db-helpers.ts";

/** Guards the draft archive (`library-packages/{ns}/{folder}/{id}.afps`) and its row. */
export async function lockPackageDraft(tx: DbOrTx, packageId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`package-files:${packageId}`})::bigint)`,
  );
}

/** Guards the published versions (`agent-packages/{id}/{version}.afps`) and their rows. */
export async function lockPackageVersions(tx: DbOrTx, packageId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${packageId}))`);
}

/** Protect both draft writes and the row/ZIP snapshot consumed by publication. */
export function withPackageDraftLock<T>(
  packageId: string,
  work: (tx: Db) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await lockPackageDraft(tx, packageId);
    return work(tx);
  });
}
