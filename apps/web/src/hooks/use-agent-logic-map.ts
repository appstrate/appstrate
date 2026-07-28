// SPDX-License-Identifier: Apache-2.0

import { useQuery } from "@tanstack/react-query";
import { $api, type paths } from "../api/client";
import { splitPackageRef } from "../lib/package-paths";
import { isVersioned } from "../lib/version-selector";
import { useCurrentOrgId } from "./use-org";
import { useCurrentApplicationId } from "./use-current-application";

const LOGIC_MAP_PATH = "/api/agents/{scope}/{name}/logic-map" as const;

/** Query-key prefix for every version of every agent's logic map. */
export const agentLogicMapQueryKeyPrefix = ["get", LOGIC_MAP_PATH] as const;

export type AgentLogicMap =
  paths["/api/agents/{scope}/{name}/logic-map"]["get"]["responses"]["200"]["content"]["application/json"];
export type AgentLogicMapNode = AgentLogicMap["nodes"][number];
export type AgentLogicMapDiagnostic = AgentLogicMap["diagnostics"][number];

/**
 * Logic map of an agent — its prompt and the skill reference files it defers to,
 * projected as typed steps, laid out server-side and cross-checked against the
 * manifest.
 *
 * Two things set it apart from `useAgentMap`, and the UI must show both. It is
 * an INFERENCE over free text, not a projection of structured data — hence the
 * per-step evidence and the confidence. And it is stored rather than computed,
 * so it can be absent (`map: null`, before anything mapped that version) or
 * stale (`meta.stale`, when the bundle moved on).
 */
export function useAgentLogicMap(agentPackageId: string | undefined, version?: string) {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  const { scope, name } = agentPackageId
    ? splitPackageRef(agentPackageId)
    : { scope: "", name: "" };
  return useQuery(
    $api.queryOptions(
      "get",
      LOGIC_MAP_PATH,
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
