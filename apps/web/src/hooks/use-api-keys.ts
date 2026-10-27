// SPDX-License-Identifier: Apache-2.0

import { $api, type components } from "../api/client";
import { useInvalidatePaths } from "./use-invalidate-paths";
import { useOrgOnlyScope, useOrgScope } from "./use-org-scope";
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
  const scope = useOrgOnlyScope();
  const { can } = usePermissions();
  return $api.useQuery(
    "get",
    "/api/api-keys/available-scopes",
    { params: { header: scope.header } },
    { enabled: can("api-keys:read") && scope.enabled, select: (e) => e.data },
  );
}

export function useCreateApiKey() {
  const invalidate = useInvalidatePaths("/api/api-keys");
  return $api.useMutation("post", "/api/api-keys", {
    meta: { errorHandledByCaller: true },
    onSuccess: invalidate,
  });
}

export function useRevokeApiKey() {
  const invalidate = useInvalidatePaths("/api/api-keys");
  return $api.useMutation("delete", "/api/api-keys/{id}", { onSuccess: invalidate });
}
