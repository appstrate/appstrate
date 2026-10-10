// SPDX-License-Identifier: Apache-2.0

import type { EnrichedRun } from "@appstrate/shared-types";
import { causeSentence } from "./launch-warnings";

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

/** One integration of a run's "Connexions utilisées" card. */
export interface RunConnectionRow {
  integrationId: string;
  /** Every connection it bound; empty when the run started without it. */
  bound: ConnectionUsed[];
  /** Why it started without a connection, in the launch toast's words; `null` when bound. */
  unboundCause: string | null;
}

/**
 * The card's rows: one per integration the run bound, then one per declared integration it
 * started without, which `connections_used` (one entry per bound connection) cannot carry.
 */
export function runConnectionRows(
  run: Pick<EnrichedRun, "connections_used" | "integrations_unbound">,
): RunConnectionRow[] {
  const causes = new Map(
    (run.integrations_unbound ?? []).map((u) => [u.integration_package_id, causeSentence(u)]),
  );
  return groupByIntegration(run.connections_used ?? [], [...causes.keys()]).map(
    ([integrationId, bound]) => ({
      integrationId,
      bound,
      unboundCause: bound.length === 0 ? (causes.get(integrationId) ?? null) : null,
    }),
  );
}
