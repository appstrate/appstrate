// SPDX-License-Identifier: Apache-2.0

import type { EnrichedRun } from "@appstrate/shared-types";

export type ConnectionUsed = NonNullable<EnrichedRun["connections_used"]>[number];

/**
 * One row per integration: the connections it bound — several entries can share an
 * `integration_package_id`, the resolver's orders are kept — then, with none, each declared
 * integration the run started without (`unboundIds`).
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

/**
 * The declared integrations the run bound to no connection, which `connections_used` (one entry
 * per bound connection) cannot carry.
 */
export function unboundIntegrationIds(run: EnrichedRun): string[] {
  return run.integrations_unbound ?? [];
}
