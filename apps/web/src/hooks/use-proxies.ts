// SPDX-License-Identifier: Apache-2.0

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { $api, client, type components } from "../api/client";
import { splitPackageRef } from "../lib/package-paths";
import { useOrgOnlyScope, useOrgScope } from "./use-org-scope";
import { usePermissions } from "./use-permissions";
import { invalidatePaths, packageKeys } from "../lib/query-keys";
import { useInvalidatePaths } from "./use-invalidate-paths";

/** Wire shape from the OpenAPI spec (components.schemas.OrgProxy). */
export type OrgProxyInfo = components["schemas"]["OrgProxy"];

export function useProxies(enabled = true) {
  const scope = useOrgOnlyScope();
  return $api.useQuery(
    "get",
    "/api/proxies",
    { params: { header: scope.header } },
    { enabled: enabled && scope.enabled, select: (e) => e.data },
  );
}

export function useCreateProxy() {
  const invalidate = useInvalidatePaths("/api/proxies");
  // The proxy form shows a refusal under its fields.
  return $api.useMutation("post", "/api/proxies", {
    meta: { errorHandledByCaller: true },
    onSuccess: invalidate,
  });
}

export function useUpdateProxy() {
  const invalidate = useInvalidatePaths("/api/proxies");
  return $api.useMutation("patch", "/api/proxies/{id}", {
    meta: { errorHandledByCaller: true },
    onSuccess: invalidate,
  });
}

export function useDeleteProxy() {
  const invalidate = useInvalidatePaths("/api/proxies");
  return $api.useMutation("delete", "/api/proxies/{id}", { onSuccess: invalidate });
}

export function useSetDefaultProxy() {
  const invalidate = useInvalidatePaths("/api/proxies");
  return $api.useMutation("put", "/api/proxies/default", { onSuccess: invalidate });
}

export function useTestProxy() {
  return $api.useMutation("post", "/api/proxies/{id}/test", {
    meta: { errorHandledByCaller: true },
  });
}

/** `agents:read` alone: unlike the agent detail, `agents:run` does not open it. */
export function useAgentProxy(packageId: string | undefined) {
  const scope = useOrgScope();
  const { can } = usePermissions();
  return $api.useQuery(
    "get",
    "/api/agents/{scope}/{name}/proxy",
    { params: { header: scope.header, path: splitPackageRef(packageId ?? "") } },
    { enabled: can("agents:read") && scope.enabled && !!packageId },
  );
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
      void invalidatePaths(qc, ["/api/agents/{scope}/{name}/proxy"]);
      qc.invalidateQueries({ queryKey: packageKeys.family("agents") });
    },
  });
}
