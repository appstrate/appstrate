// SPDX-License-Identifier: Apache-2.0

/**
 * Lock-order tests on a real PostgreSQL. PGlite runs one statement at a time, so two concurrent
 * requests pass whether or not the locks exist: a test that means to discriminate holds a lock
 * in an open transaction, starts the writer, proves through `pg_locks` that the writer is
 * WAITING on it, then releases. Callers skip on `isEmbeddedDb`.
 */

import { sql } from "drizzle-orm";
import { db, toRows } from "@appstrate/db/client";

/** The backend pid of the transaction `tx`, to hand to {@link waitsOn}. */
export async function backendPid(tx: Pick<typeof db, "execute">): Promise<number> {
  return toRows<{ pid: number }>(await tx.execute(sql`SELECT pg_backend_pid() AS pid`))[0]!.pid;
}

/** Resolves once some lock request of another backend waits on `blockerPid`; throws after 5 s. */
export async function waitsOn(blockerPid: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const rows = toRows<{ waiting: boolean }>(
      await db.execute(
        sql`SELECT EXISTS (
          SELECT 1 FROM pg_locks
          WHERE NOT granted AND ${blockerPid} = ANY(pg_blocking_pids(pid))
        ) AS waiting`,
      ),
    );
    if (rows[0]!.waiting) return;
    await Bun.sleep(10);
  }
  throw new Error("the concurrent write never waited on the blocker");
}
