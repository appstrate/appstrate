// SPDX-License-Identifier: Apache-2.0

import { useQuery } from "@tanstack/react-query";
import { $api, type paths } from "../../api/client";
import { splitPackageRef } from "../../lib/package-paths";
import { isVersioned } from "../../lib/version-selector";
import { useCurrentOrgId } from "../../hooks/use-org";
import { useCurrentApplicationId } from "../../hooks/use-current-application";

const MAP_PATH = "/api/agents/{scope}/{name}/map" as const;

/**
 * Query-key prefix for every version of every agent's map.
 *
 * Exported so a writer that changes an agent's definition can invalidate the
 * map it is displayed next to. `useUpdatePackage` cannot do it: its invalidation
 * list is about packages, and the typed client keys queries by
 * `[method, path, init]` — a path this prefix matches partially.
 */
export const agentMapQueryKeyPrefix = ["get", MAP_PATH] as const;

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
      MAP_PATH,
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
