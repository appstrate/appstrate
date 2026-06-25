// SPDX-License-Identifier: Apache-2.0

import { useAgentConnectionReadiness } from "./use-integrations";

export interface AgentIntegrationsReadiness {
  /** True while the readiness verdict is still loading. */
  loading: boolean;
  /** Declared integrations whose connection would 412 at run kickoff. */
  blockingCount: number;
  /** No integration blocks the run. */
  ready: boolean;
}

/**
 * Launch-time integration readiness for an agent — the predicate behind the
 * run button's orange "connections needed" badge.
 *
 * Reads the single bulk `connection-readiness` query (server-authoritative —
 * the same resolver the run-kickoff 412 runs, including the required-auth
 * carve-out for declared-but-inert integrations). One call drives this badge,
 * the Connexions tab, and the pre-run check, so they can never disagree.
 */
export function useAgentIntegrationsReadiness(
  agentPackageId: string | undefined,
): AgentIntegrationsReadiness {
  const { data, isLoading } = useAgentConnectionReadiness(agentPackageId);
  const blockingCount = data?.integrations.filter((i) => i.run_blocking).length ?? 0;
  // `ready` stays true until data lands so the badge doesn't flash on load.
  return { loading: isLoading, blockingCount, ready: data ? !data.blocks_run : true };
}
