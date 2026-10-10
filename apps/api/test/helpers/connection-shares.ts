// SPDX-License-Identifier: Apache-2.0

import { integrationConnectionShares } from "@appstrate/db/schema";
import { db } from "./db.ts";

/**
 * Shares a connection into each of `spaceIds` (one `integration_connection_shares` row per
 * space). Fixtures call it after inserting the connection; `sharedBy` defaults to no sharer.
 */
export async function seedShares(
  connectionId: string,
  spaceIds: string[],
  sharedBy?: string,
): Promise<void> {
  if (spaceIds.length === 0) return;
  await db
    .insert(integrationConnectionShares)
    .values(spaceIds.map((spaceId) => ({ connectionId, spaceId, sharedBy: sharedBy ?? null })))
    .onConflictDoNothing();
}
