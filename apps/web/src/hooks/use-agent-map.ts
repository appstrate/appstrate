// SPDX-License-Identifier: Apache-2.0

import { useQuery } from "@tanstack/react-query";
import { $api, type paths } from "../api/client";
import { splitPackageRef } from "../lib/package-paths";
import { isVersioned } from "../lib/version-selector";
import { useCurrentOrgId } from "./use-org";
import { useCurrentApplicationId } from "./use-current-application";

export type AgentMap =
  paths["/api/agents/{scope}/{name}/map"]["get"]["responses"]["200"]["content"]["application/json"];
export type AgentMapNode = AgentMap["nodes"][number];
export type AgentMapDiagnostic = AgentMap["diagnostics"][number];

/**
 * Visual map of an agent — its manifest projected as positioned nodes and
 * edges, crossed with the installation state, plus readiness diagnostics
 * already routed to the node and row they describe.
 *
 * Server-computed on purpose: resolving versions, connections and schedules
 * needs the database, and the layout must be identical for every client.
 * A non-`draft` version maps that published manifest instead, and rides the
 * query so the cache key splits per version.
 */
export function useAgentMap(agentPackageId: string | undefined, version?: string) {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  const { scope, name } = agentPackageId
    ? splitPackageRef(agentPackageId)
    : { scope: "", name: "" };
  return useQuery(
    $api.queryOptions(
      "get",
      "/api/agents/{scope}/{name}/map",
      {
        params: {
          path: { scope, name },
          ...(isVersioned(version) ? { query: { version } } : {}),
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
