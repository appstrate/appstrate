// SPDX-License-Identifier: Apache-2.0

import { useQueries } from "@tanstack/react-query";
import type { AgentIntegrationEntry } from "@appstrate/shared-types";
import { useCurrentOrgId } from "./use-org";
import { useCurrentApplicationId } from "./use-current-application";
import { agentResolutionQueryOptions } from "./use-integrations";
import {
  isIntegrationEntryActive,
  resolutionBlocksRun,
} from "../components/integration-connect/integration-run-readiness";

export interface AgentIntegrationsReadiness {
  /** True while any active integration's resolution is still loading. */
  loading: boolean;
  /** Active integrations whose connection would 412 at run kickoff. */
  blockingCount: number;
  /** No active integration blocks the run. */
  ready: boolean;
}

/**
 * Launch-time integration readiness for an agent — the predicate behind the
 * run button's orange "connections needed" badge.
 *
 * Calls the per-integration agent-resolution endpoint (server-authoritative,
 * the same resolver cascade the run-kickoff 412 runs) for every ACTIVE
 * integration the agent declares, then aggregates with {@link resolutionBlocksRun}.
 * The query options come from the same builder as `useIntegrationAgentResolution`,
 * so when the Connexions tab is open the cache is shared — no duplicate
 * fetches, and the badge can never disagree with the tab.
 *
 * Inert integrations (the agent selected no tool/scope) are skipped: the
 * runtime never spawns them, so they never gate Run.
 */
export function useAgentIntegrationsReadiness(
  agentPackageId: string | undefined,
  entries: AgentIntegrationEntry[] | undefined,
): AgentIntegrationsReadiness {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  const active = (entries ?? []).filter(isIntegrationEntryActive);

  const results = useQueries({
    // Shared options builder → same cache entry as `useIntegrationAgentResolution`,
    // so the badge and the Connexions tab never fetch the verdict twice.
    queries: active.map((entry) =>
      agentResolutionQueryOptions(orgId, applicationId, entry.id, agentPackageId),
    ),
  });

  const loading = results.some((r) => r.isLoading);
  // Only resolved verdicts count, so the badge stays hidden until data lands
  // (no warning flash before the resolutions arrive).
  const blockingCount = results.filter((r) => r.data && resolutionBlocksRun(r.data)).length;

  return { loading, blockingCount, ready: blockingCount === 0 };
}
