// SPDX-License-Identifier: Apache-2.0

/**
 * The dashboard's agents, those of the latest runs first: most recent first, one per agent, at
 * most `limit` of them, then every other agent listed. A run whose agent is no longer listed
 * (deleted, switched off) puts nothing first.
 */
export function recentAgentsFirst<A extends { id: string }>(
  runs: readonly { packageId: string | null }[],
  agents: readonly A[],
  limit = 8,
): A[] {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const first: A[] = [];
  const seen = new Set<string>();
  for (const run of runs) {
    if (first.length >= limit) break;
    if (!run.packageId || seen.has(run.packageId)) continue;
    seen.add(run.packageId);
    const agent = byId.get(run.packageId);
    if (agent) first.push(agent);
  }
  const shown = new Set(first);
  return [...first, ...agents.filter((agent) => !shown.has(agent))];
}
