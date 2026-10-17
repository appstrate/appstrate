// SPDX-License-Identifier: Apache-2.0

/**
 * The tile of the agent a run executed: its `icon` and `color`.
 *
 * Unlike the name, a run snapshots no identity: `agent_name` is denormalized at
 * INSERT time, the icon is not. So the tile is read off the agents the org can
 * see, and a run whose agent is gone (FK SET NULL) or inline (a shadow package
 * no list holds) resolves to `NO_AGENT_IDENTITY` — which `PackageIcon` draws as
 * the default agent tile, never as a hole in the row.
 */

import type { AgentListItem, EnrichedRun } from "@appstrate/shared-types";
import { useAgents } from "./use-packages";

export type RunAgentIdentity = Pick<AgentListItem, "icon" | "color">;

/** No icon, no colour: the default agent tile. */
const NO_AGENT_IDENTITY: RunAgentIdentity = { icon: null, color: null };

/** Exported pure, so the lookup can be tested without a query client. */
export function resolveRunAgentIdentity(
  run: EnrichedRun,
  byPackageId: ReadonlyMap<string, RunAgentIdentity>,
): RunAgentIdentity {
  if (run.package_ephemeral === true || run.packageId == null) return NO_AGENT_IDENTITY;
  return byPackageId.get(run.packageId) ?? NO_AGENT_IDENTITY;
}

/** Same `useAgents()` query key as `useRunAgentName`: served from cache, not an extra request. */
export function useRunAgentIdentity(): (run: EnrichedRun) => RunAgentIdentity {
  const { data: agents } = useAgents();

  const byPackageId = new Map<string, RunAgentIdentity>();
  for (const agent of agents ?? []) {
    byPackageId.set(agent.id, { icon: agent.icon, color: agent.color });
  }

  return (run) => resolveRunAgentIdentity(run, byPackageId);
}
