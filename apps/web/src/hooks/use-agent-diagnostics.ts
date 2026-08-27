// SPDX-License-Identifier: Apache-2.0

import { useQuery } from "@tanstack/react-query";
import { $api, type paths } from "../api/client";
import { splitPackageRef } from "../lib/package-paths";
import { useCurrentApplicationId } from "./use-current-application";
import { useCurrentOrgId } from "./use-org";

export type AgentDiagnostics =
  paths["/api/agents/{scope}/{name}/diagnostics"]["get"]["responses"]["200"]["content"]["application/json"];
export type AgentDiagnostic = AgentDiagnostics["diagnostics"][number];

export function useAgentDiagnostics(agentPackageId: string | undefined, version?: string) {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  const path = agentPackageId ? splitPackageRef(agentPackageId) : { scope: "", name: "" };

  return useQuery(
    $api.queryOptions(
      "get",
      "/api/agents/{scope}/{name}/diagnostics",
      {
        params: {
          path,
          ...(version ? { query: { version } } : {}),
          header: {
            "X-Org-Id": orgId ?? undefined,
            "X-Application-Id": applicationId ?? undefined,
          },
        },
      },
      { enabled: Boolean(orgId && applicationId && agentPackageId) },
    ),
  );
}

/**
 * Blocking connection diagnostics remain launchable because Run opens the
 * existing 412 recovery flow. Every other blocker disables launch. The status
 * badge still remains blocking, so this is an interaction capability, not a
 * second readiness verdict.
 */
export function diagnosticsAllowLaunch(data: AgentDiagnostics | undefined): boolean {
  return data?.can_launch ?? false;
}
