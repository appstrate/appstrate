// SPDX-License-Identifier: Apache-2.0

import type { EnrichedRun } from "@appstrate/shared-types";

export type ConnectionUsed = NonNullable<EnrichedRun["connections_used"]>[number];

/**
 * Group a run's `connections_used` by integration.
 *
 * The snapshot holds one entry per BOUND connection, so an integration bound
 * to several contributes several entries sharing an `integration_id` — the
 * run panel renders one card per integration listing each of them. First-seen
 * integration order is preserved, and so is the snapshot order inside a group:
 * that order is the resolver's, and renumbering it would make two runs of the
 * same agent look different for no reason.
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
