// SPDX-License-Identifier: Apache-2.0

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { $api, type components } from "../api/client";
import { useCurrentOrgId } from "./use-org";
import { useCurrentApplicationId } from "./use-current-application";

/** Wire shape from the OpenAPI spec (components.schemas.OrgProxy). */
export type OrgProxyInfo = components["schemas"]["OrgProxy"];

/**
 * Org context for queries. The header is a spec-declared param passed
 * explicitly (instead of relying on the client middleware alone) so it is
 * part of the React Query key — switching org refetches instead of serving
 * another org's cached page.
 */
function useOrgScope() {
  const orgId = useCurrentOrgId();
  return {
    enabled: !!orgId,
    header: { "X-Org-Id": orgId ?? undefined },
  };
}

export function useProxies() {
  const scope = useOrgScope();
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

// NOTE: the agent-scoped hooks below stay on the legacy `api()` helper. The
// typed client percent-encodes path params (`@scope` → `%40scope`) and the
// API's `:scope{@[^/]+}` route patterns match the raw path, so encoded
// scopes 404. Migrate once the client gains a reserved-safe path serializer.

export function useAgentProxy(packageId: string | undefined) {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useQuery({
    queryKey: ["agent-proxy", orgId, applicationId, packageId],
    queryFn: () =>
      api<{ proxyId: string | null; proxyLabel?: string; resolved: boolean }>(
        `/agents/${packageId}/proxy`,
      ),
    enabled: !!orgId && !!applicationId && !!packageId,
  });
}

export function useSetAgentProxy(packageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (proxyId: string | null) => {
      return api(`/agents/${packageId}/proxy`, {
        method: "PUT",
        body: JSON.stringify({ proxyId }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agent-proxy"] });
      qc.invalidateQueries({ queryKey: ["packages", "agent"] });
    },
  });
}
