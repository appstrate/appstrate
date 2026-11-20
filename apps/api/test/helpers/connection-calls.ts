// SPDX-License-Identifier: Apache-2.0

/**
 * The call journal as a test reads it. Journal rows are written off the response path
 * (`trackAudit`), so a test drains them before it reads, and after it ends (`afterEach`) so none
 * lands in the next test's database; rows are read for the test's own organization only.
 */

import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { connectionCalls } from "@appstrate/db/schema";
import { drainAudits } from "../../src/services/audit.ts";

/** Waits for every pending journal (and audit) write of the process. */
export const drainJournal = () => drainAudits(5_000);

/** The rows journaled in `scope`'s organization for `integrationId`, oldest first. */
export async function journaledCalls(scope: { orgId: string }, integrationId: string) {
  await drainJournal();
  return db
    .select()
    .from(connectionCalls)
    .where(
      and(eq(connectionCalls.orgId, scope.orgId), eq(connectionCalls.integrationId, integrationId)),
    )
    .orderBy(connectionCalls.id);
}
