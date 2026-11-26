// SPDX-License-Identifier: Apache-2.0

/**
 * Reading the stored tool snapshots of a remote integration. Apart from the writer
 * (`integration-tool-snapshots.ts`) so a reader does not depend on the review fan-out it triggers.
 */

import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { integrationToolSnapshots, type ToolSnapshotEntry } from "@appstrate/db/schema";

export interface ToolSnapshot {
  connectionId: string | null;
  listedAt: Date;
  truncated: boolean;
  tools: ToolSnapshotEntry[];
}

/** The snapshots of the integration's targets named: a connection's, or `null` for the shared one. */
export async function readToolSnapshots(input: {
  orgId: string;
  packageId: string;
  connectionIds: readonly (string | null)[];
}): Promise<ToolSnapshot[]> {
  const connections = input.connectionIds.filter((id): id is string => id !== null);
  const targets = [
    ...(connections.length > 0
      ? [inArray(integrationToolSnapshots.connectionId, connections)]
      : []),
    ...(input.connectionIds.includes(null) ? [isNull(integrationToolSnapshots.connectionId)] : []),
  ];
  if (targets.length === 0) return [];
  return db
    .select({
      connectionId: integrationToolSnapshots.connectionId,
      listedAt: integrationToolSnapshots.listedAt,
      truncated: integrationToolSnapshots.truncated,
      tools: integrationToolSnapshots.tools,
    })
    .from(integrationToolSnapshots)
    .where(
      and(
        eq(integrationToolSnapshots.orgId, input.orgId),
        eq(integrationToolSnapshots.packageId, input.packageId),
        or(...targets),
      ),
    );
}
