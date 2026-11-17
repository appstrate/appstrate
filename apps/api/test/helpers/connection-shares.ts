// SPDX-License-Identifier: Apache-2.0

import { eq } from "drizzle-orm";
import { integrationConnections, integrationConnectionShares } from "@appstrate/db/schema";
import type { ConnectionCaller } from "../../src/services/connection-reach.ts";
import { boundSpaceOf, type ConnectionPrincipal } from "../../src/lib/connection-principal.ts";
import { db } from "./db.ts";

/**
 * A connection caller acting from no space, holding `integrations:connect`, permissions nowhere,
 * seeing no space and naming any space but outside the one its principal is bound to, unless
 * `overrides` say otherwise.
 */
export function testCaller(
  principal: ConnectionPrincipal,
  overrides: Partial<ConnectionCaller> = {},
): ConnectionCaller {
  const bound = boundSpaceOf(principal);
  return {
    principal,
    spaceId: null,
    canConnect: true,
    governs: false,
    admitsSpace: (spaceId) => bound === null || spaceId === bound,
    permissionsIn: async () => new Set(),
    spacesSeen: async () => [],
    ...overrides,
  };
}

/**
 * Shares a connection into each of `spaceIds` (one `integration_connection_shares` row per
 * space, in the connection's org). Fixtures call it after inserting the connection.
 */
export async function seedShares(connectionId: string, spaceIds: string[]): Promise<void> {
  if (spaceIds.length === 0) return;
  const [connection] = await db
    .select({ orgId: integrationConnections.orgId })
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connectionId));
  if (!connection) throw new Error(`seedShares: no connection '${connectionId}'`);
  await db
    .insert(integrationConnectionShares)
    .values(spaceIds.map((spaceId) => ({ connectionId, spaceId, orgId: connection.orgId })))
    .onConflictDoNothing();
}
