// SPDX-License-Identifier: Apache-2.0

import { sql } from "drizzle-orm";
import { db, type Db } from "@appstrate/db/client";

/** Protect both draft writes and the row/ZIP snapshot consumed by publication. */
export function withPackageDraftLock<T>(
  packageId: string,
  work: (tx: Db) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`package-files:${packageId}`})::bigint)`,
    );
    return work(tx);
  });
}
