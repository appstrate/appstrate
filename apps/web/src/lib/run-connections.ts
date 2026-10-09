// SPDX-License-Identifier: Apache-2.0

import type { EnrichedRun } from "@appstrate/shared-types";

export type ConnectionUsed = NonNullable<EnrichedRun["connections_used"]>[number];

/**
 * Several snapshot entries can share an `integration_package_id`; the resolver's orders are kept.
 * The integrations the run started without follow, with no connection.
 */
export function groupByIntegration(
  used: ConnectionUsed[],
  unboundIds: readonly string[] = [],
): [string, ConnectionUsed[]][] {
  const groups = new Map<string, ConnectionUsed[]>();
  for (const c of used) {
    const bucket = groups.get(c.integration_package_id);
    if (bucket) bucket.push(c);
    else groups.set(c.integration_package_id, [c]);
  }
  for (const id of unboundIds) if (!groups.has(id)) groups.set(id, []);
  return [...groups.entries()];
}
