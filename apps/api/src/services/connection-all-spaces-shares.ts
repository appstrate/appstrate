// SPDX-License-Identifier: Apache-2.0

import { and, asc, eq, inArray } from "drizzle-orm";
import {
  integrationConnections as c,
  integrationConnectionShares as shares,
} from "@appstrate/db/schema";
import type { Tx } from "../lib/db-helpers.ts";
import { recordAudit } from "./audit.ts";

/**
 * Caller holds `lockOrganizationRow`. Only team-space creation/conversion enters this path. A set
 * flag means its owner administers the org: demotion and departure clear it under the same lock.
 */
export async function shareConnectionsWithNewSpace(tx: Tx, orgId: string, spaceId: string) {
  const rows = await tx
    .select({ id: c.id })
    .from(c)
    .where(and(eq(c.orgId, orgId), eq(c.shareAllSpaces, true)))
    .orderBy(asc(c.id))
    .for("update", { of: c });
  if (rows.length === 0) return [];
  const added = await tx
    .insert(shares)
    .values(rows.map((row) => ({ connectionId: row.id, orgId, spaceId })))
    .onConflictDoNothing()
    .returning({ id: shares.connectionId });
  if (added.length > 0)
    await tx
      .update(c)
      .set({ updatedAt: new Date() })
      .where(
        inArray(
          c.id,
          added.map((row) => row.id),
        ),
      );
  return added.map((row) => row.id);
}

/** After commit, record which consent opened the new team space. */
export async function recordAllSpacesShares(orgId: string, spaceId: string, ids: string[]) {
  for (const id of ids)
    await recordAudit({
      orgId,
      spaceId,
      actorType: "system",
      action: "integration.connection.share_added",
      resourceType: "integration_connection",
      resourceId: id,
      after: { spaceId, reason: "all_spaces" },
    });
}
