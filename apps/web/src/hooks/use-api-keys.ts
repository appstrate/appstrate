// SPDX-License-Identifier: Apache-2.0

import { useQueryClient } from "@tanstack/react-query";
import { $api, type components } from "../api/client";
import { useCurrentOrgId } from "./use-org";
import { useCurrentApplicationId } from "./use-current-application";

/** Wire shape from the OpenAPI spec (components.schemas.ApiKeyInfo). */
export type ApiKeyInfo = components["schemas"]["ApiKeyInfo"];

/**
 * Org/app context for queries. The headers are spec-declared params passed
 * explicitly (instead of relying on the client middleware alone) so they are
 * part of the React Query key — switching org or application refetches
 * instead of serving another scope's cached page.
 */
function useOrgScope() {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return {
    enabled: !!orgId && !!applicationId,
    header: {
      "X-Org-Id": orgId ?? undefined,
      "X-Application-Id": applicationId ?? undefined,
    },
  };
}

export function useApiKeys() {
  const scope = useOrgScope();
  return $api.useQuery(
    "get",
    "/api/api-keys",
    { params: { header: scope.header } },
    { enabled: scope.enabled, select: (e) => e.data },
  );
}

export function useAvailableScopes() {
  const orgId = useCurrentOrgId();
  return $api.useQuery(
    "get",
    "/api/api-keys/available-scopes",
    { params: { header: { "X-Org-Id": orgId ?? undefined } } },
    { enabled: !!orgId, select: (e) => e.data },
  );
}

export function useCreateApiKey() {
  const qc = useQueryClient();
  return $api.useMutation("post", "/api/api-keys", {
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["get", "/api/api-keys"] });
    },
  });
}

export function useRevokeApiKey() {
  const qc = useQueryClient();
  return $api.useMutation("delete", "/api/api-keys/{id}", {
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["get", "/api/api-keys"] });
    },
  });
}
