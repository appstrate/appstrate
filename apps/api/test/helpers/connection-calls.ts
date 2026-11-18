// SPDX-License-Identifier: Apache-2.0

/** The call journal as a test reads it: once every pending write has landed. */

import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { connectionCalls } from "@appstrate/db/schema";
import { drainAudits } from "../../src/services/audit.ts";

/** The rows journaled for `integrationId`, oldest first. */
export async function journaledCalls(integrationId: string) {
  await drainAudits(5_000);
  return db
    .select()
    .from(connectionCalls)
    .where(eq(connectionCalls.integrationId, integrationId))
    .orderBy(connectionCalls.id);
}
