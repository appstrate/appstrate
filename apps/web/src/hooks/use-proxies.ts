// SPDX-License-Identifier: Apache-2.0

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { $api, client, type components } from "../api/client";
import { splitPackageRef } from "../lib/package-paths";
import { useCurrentOrgId } from "./use-org";
import { useCurrentApplicationId } from "./use-current-application";
import { useOrgOnlyScope } from "./use-org-scope";
import { agentProxyKeys, packageKeys } from "../lib/query-keys";

/** Wire shape from the OpenAPI spec (components.schemas.OrgProxy). */
export type OrgProxyInfo = components["schemas"]["OrgProxy"];

export function useProxies() {
  const scope = useOrgOnlyScope();
  return $api.useQuery(
    "get",
    "/api/proxies",
    { params: { header: scope.header } },
    { enabled: scope.enabled, select: (e) => e.data },
  );
}

/** openapi-react-query keys are [method, path, init] — invalidate the literal spec path. */
function useInvalidateProxies() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["get", "/api/proxies"] });
  };
}

export function useCreateProxy() {
  const invalidate = useInvalidateProxies();
  return $api.useMutation("post", "/api/proxies", { onSuccess: invalidate });
}

export function useUpdateProxy() {
  const invalidate = useInvalidateProxies();
  return $api.useMutation("put", "/api/proxies/{id}", { onSuccess: invalidate });
}

export function useDeleteProxy() {
  const invalidate = useInvalidateProxies();
  return $api.useMutation("delete", "/api/proxies/{id}", { onSuccess: invalidate });
}

export function useSetDefaultProxy() {
  const invalidate = useInvalidateProxies();
  return $api.useMutation("put", "/api/proxies/default", { onSuccess: invalidate });
}

export function useTestProxy() {
  return $api.useMutation("post", "/api/proxies/{id}/test");
}

export function useAgentProxy(packageId: string | undefined) {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useQuery({
    // Key kept legacy-shaped: invalidated by useSetAgentProxy below and
    // app-switch resets.
    queryKey: agentProxyKeys.detail(orgId, applicationId, packageId),
    queryFn: async () => {
      const { data } = await client.GET("/api/agents/{scope}/{name}/proxy", {
        params: { path: splitPackageRef(packageId!) },
      });
      return data!;
    },
    enabled: !!orgId && !!applicationId && !!packageId,
  });
}

export function useSetAgentProxy(packageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (proxyId: string | null) => {
      const { data } = await client.PUT("/api/agents/{scope}/{name}/proxy", {
        params: { path: splitPackageRef(packageId) },
        body: { proxyId },
      });
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: agentProxyKeys.all });
      qc.invalidateQueries({ queryKey: packageKeys.family("agents") });
    },
  });
}
