// SPDX-License-Identifier: Apache-2.0

import { eq } from "drizzle-orm";
import { integrationConnections } from "@appstrate/db/schema";
import { credentialRevision } from "../../src/services/integration-connections.ts";
import { db } from "./db.ts";

/** The connection's current `credentialRevision`; `null` once the row is gone. */
export async function readCredentialRevision(connectionId: string): Promise<string | null> {
  const [row] = await db
    .select({ credentialRevision })
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connectionId))
    .limit(1);
  return row?.credentialRevision ?? null;
}
