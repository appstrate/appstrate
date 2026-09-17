// SPDX-License-Identifier: Apache-2.0

import { useAgentConnectionReadiness } from "./use-integrations";

interface AgentIntegrationsReadiness {
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
 *
 * `blocks_run` is deliberately NOT the source: it answers the wider question
 * "would the run be refused", and since the readiness read reports the space
 * having the agent switched off (`agent_not_active`) rather than 404-ing, it is
 * true for a cause no connection can fix. The badge would then send a reader to
 * the Connexions tab for a switch that lives elsewhere. Integration entries
 * carry their own `run_blocking` flag, so the count and the verdict come from
 * the same place; inactivity is said by the page's own banner.
 */
export function useAgentIntegrationsReadiness(
  agentPackageId: string | undefined,
): AgentIntegrationsReadiness {
  const { data, isLoading } = useAgentConnectionReadiness(agentPackageId);
  const blockingCount = data?.integrations.filter((i) => i.run_blocking).length ?? 0;
  // `ready` stays true until data lands so the badge doesn't flash on load.
  return { loading: isLoading, blockingCount, ready: data ? blockingCount === 0 : true };
}
