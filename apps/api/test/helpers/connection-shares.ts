// SPDX-License-Identifier: Apache-2.0

import { eq } from "drizzle-orm";
import { integrationConnections, integrationConnectionShares } from "@appstrate/db/schema";
import { db } from "./db.ts";

/**
 * Shares a connection into each of `spaceIds` (one `integration_connection_shares` row per
 * space, in the connection's org). Fixtures call it after inserting the connection; `sharedBy`
 * defaults to no sharer.
 */
export async function seedShares(
  connectionId: string,
  spaceIds: string[],
  sharedBy?: string,
): Promise<void> {
  if (spaceIds.length === 0) return;
  const [connection] = await db
    .select({ orgId: integrationConnections.orgId })
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connectionId));
  if (!connection) throw new Error(`seedShares: no connection '${connectionId}'`);
  await db
    .insert(integrationConnectionShares)
    .values(
      spaceIds.map((spaceId) => ({
        connectionId,
        spaceId,
        orgId: connection.orgId,
        sharedBy: sharedBy ?? null,
      })),
    )
    .onConflictDoNothing();
}
