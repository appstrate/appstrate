// SPDX-License-Identifier: Apache-2.0

import { useQueryClient } from "@tanstack/react-query";
import { $api, type components } from "../api/client";
import { useCurrentOrgId } from "./use-org";
import { useOrgScope } from "./use-org-scope";

/** Wire shape from the OpenAPI spec (components.schemas.ApiKeyInfo). */
export type ApiKeyInfo = components["schemas"]["ApiKeyInfo"];

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
