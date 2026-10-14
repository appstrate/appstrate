// SPDX-License-Identifier: Apache-2.0

import { blockingIntegrationIds, useAgentConnectionReadiness } from "./use-integrations";

/**
 * Whether no declared integration blocks a launch of the agent — the predicate
 * behind the run button's orange "connections needed" badge. True until the
 * verdict lands, so the badge does not flash on load.
 *
 * Reads the single bulk `connection-readiness` query (server-authoritative —
 * the same resolver the run-kickoff 409 runs, including the required-auth
 * carve-out for declared-but-inert integrations). One call drives this badge
 * and the Connexions tab, so they can never disagree.
 *
 * `blocks_run` is deliberately NOT the source: it answers the wider question
 * "would the run be refused", and since the readiness read reports the space
 * having the agent switched off (`agent_not_active`) rather than 404-ing, it is
 * true for a cause no connection can fix. The badge would then send a reader to
 * the Connexions tab for a switch that lives elsewhere. Integration entries
 * carry their own `run_blocking` flag; inactivity is said by the page's own banner.
 */
export function useAgentIntegrationsReadiness(agentPackageId: string | undefined): boolean {
  const { data } = useAgentConnectionReadiness(agentPackageId);
  return !data || blockingIntegrationIds(data).length === 0;
}
