// SPDX-License-Identifier: Apache-2.0

import { useAgentConnectionReadiness } from "./use-integrations";
import { integrationRunState } from "../components/integration-connect/integration-run-readiness";

interface AgentIntegrationsReadiness {
  /** True while the readiness verdict is still loading. */
  loading: boolean;
  /** Declared integrations whose connection would 409 at run kickoff. */
  blockingCount: number;
  /** No integration blocks the run. */
  ready: boolean;
}

/**
 * Launch-time integration readiness for an agent — the predicate behind the
 * run button's orange "connections needed" badge.
 *
 * Reads the single bulk `connection-readiness` query (server-authoritative —
 * the same resolver the run-kickoff 409 runs, including the required-auth
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
 *
 * An integration the agent does not require and nothing binds is `unbound`, not blocking: the
 * run starts without it, so it never lights the badge.
 */
export function useAgentIntegrationsReadiness(
  agentPackageId: string | undefined,
): AgentIntegrationsReadiness {
  const { data, isLoading } = useAgentConnectionReadiness(agentPackageId);
  const blockingCount =
    data?.integrations.filter((i) => integrationRunState(i) === "blocked").length ?? 0;
  // `ready` stays true until data lands so the badge doesn't flash on load.
  return { loading: isLoading, blockingCount, ready: data ? blockingCount === 0 : true };
}
