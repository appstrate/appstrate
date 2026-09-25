// SPDX-License-Identifier: Apache-2.0

import { useQueryClient } from "@tanstack/react-query";
import { $api, type components } from "../api/client";
import { useCurrentOrgId } from "./use-org";
import { useOrgScope } from "./use-org-scope";
import { usePermissions } from "./use-permissions";

/** Wire shape from the OpenAPI spec (components.schemas.ApiKeyInfo). */
export type ApiKeyInfo = components["schemas"]["ApiKeyInfo"];

/** Both reads guard on `api-keys:read`, which only a space `admin` preset holds. */
export function useApiKeys() {
  const scope = useOrgScope();
  const { can } = usePermissions();
  return $api.useQuery(
    "get",
    "/api/api-keys",
    { params: { header: scope.header } },
    { enabled: can("api-keys:read") && scope.enabled, select: (e) => e.data },
  );
}

export function useAvailableScopes() {
  const orgId = useCurrentOrgId();
  const { can } = usePermissions();
  return $api.useQuery(
    "get",
    "/api/api-keys/available-scopes",
    { params: { header: { "X-Org-Id": orgId ?? undefined } } },
    { enabled: can("api-keys:read") && !!orgId, select: (e) => e.data },
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
