// SPDX-License-Identifier: Apache-2.0

import type { EnrichedRun } from "@appstrate/shared-types";

export type ConnectionUsed = NonNullable<EnrichedRun["connections_used"]>[number];

/**
 * The snapshot holds one entry per BOUND connection, so several can share an
 * `integration_id`; both orders are the resolver's and are preserved as-is.
 */
export function groupByIntegration(used: ConnectionUsed[]): [string, ConnectionUsed[]][] {
  const groups = new Map<string, ConnectionUsed[]>();
  for (const c of used) {
    const bucket = groups.get(c.integration_id);
    if (bucket) bucket.push(c);
    else groups.set(c.integration_id, [c]);
  }
  return [...groups.entries()];
}
