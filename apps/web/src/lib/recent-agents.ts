// SPDX-License-Identifier: Apache-2.0

interface Placed {
  id: string;
  spaceId: string;
}

interface RunOf {
  packageId: string | null;
  spaceId: string;
}

/** An agent in one space: what a list spanning spaces holds once per space. */
const placement = (packageId: string, spaceId: string) => `${spaceId}:${packageId}`;

/**
 * The dashboard's agents, those of the latest runs first: most recent first, one per agent AND
 * space, at most `limit` of them, then every other agent listed. A run whose agent is no longer
 * listed (deleted, switched off) puts nothing first.
 */
export function recentAgentsFirst<A extends Placed>(
  runs: readonly RunOf[],
  agents: readonly A[],
  limit = 8,
): A[] {
  const byPlacement = new Map(agents.map((agent) => [placement(agent.id, agent.spaceId), agent]));
  const first: A[] = [];
  const seen = new Set<string>();
  for (const run of runs) {
    if (first.length >= limit) break;
    if (!run.packageId) continue;
    const key = placement(run.packageId, run.spaceId);
    if (seen.has(key)) continue;
    seen.add(key);
    const agent = byPlacement.get(key);
    if (agent) first.push(agent);
  }
  const shown = new Set(first);
  return [...first, ...agents.filter((agent) => !shown.has(agent))];
}
