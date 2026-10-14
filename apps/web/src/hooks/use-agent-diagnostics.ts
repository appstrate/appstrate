// SPDX-License-Identifier: Apache-2.0

import { useQuery, type QueryClient } from "@tanstack/react-query";
import { $api, type paths } from "../api/client";
import { splitPackageRef } from "../lib/package-paths";
import { useOrgScope } from "./use-org-scope";
import { usePermissions } from "./use-permissions";

export type AgentDiagnostics =
  paths["/api/agents/{scope}/{name}/diagnostics"]["get"]["responses"]["200"]["content"]["application/json"];
export type AgentDiagnostic = AgentDiagnostics["diagnostics"][number];

export function useAgentDiagnostics(agentPackageId: string | undefined, version?: string) {
  const scope = useOrgScope();
  // The diagnostics describe what the agent is made of: `agents:read`, like the
  // route. A runner without it launches, and the kickoff's own check recovers.
  const canRead = usePermissions().can("agents:read");
  const path = agentPackageId ? splitPackageRef(agentPackageId) : { scope: "", name: "" };

  return useQuery(
    $api.queryOptions(
      "get",
      "/api/agents/{scope}/{name}/diagnostics",
      {
        params: {
          path,
          ...(version ? { query: { version } } : {}),
          header: scope.header,
        },
      },
      { enabled: canRead && scope.enabled && Boolean(agentPackageId) },
    ),
  );
}

/**
 * Every agent's diagnostics, after a write to what they report on: its model,
 * its schedules, its versions.
 */
export function invalidateAgentDiagnostics(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries({
    predicate: (query) => query.queryKey[1] === "/api/agents/{scope}/{name}/diagnostics",
  });
}
