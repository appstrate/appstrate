// SPDX-License-Identifier: Apache-2.0

import type { EnrichedRun } from "@appstrate/shared-types";

export type ConnectionUsed = NonNullable<EnrichedRun["connections_used"]>[number];

/** Several snapshot entries can share an `integration_id`; the resolver's orders are kept. */
export function groupByIntegration(used: ConnectionUsed[]): [string, ConnectionUsed[]][] {
  const groups = new Map<string, ConnectionUsed[]>();
  for (const c of used) {
    const bucket = groups.get(c.integration_id);
    if (bucket) bucket.push(c);
    else groups.set(c.integration_id, [c]);
  }
  return [...groups.entries()];
}
