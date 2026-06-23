// SPDX-License-Identifier: Apache-2.0

import { useQueryClient } from "@tanstack/react-query";
import { $api, type components } from "../api/client";
import { useOrgScope } from "./use-org-scope";

/** Wire shape from the OpenAPI spec (components.schemas.EndUserObject). */
export type EndUserInfo = components["schemas"]["EndUserObject"];

export interface EndUserListParams {
  limit?: number;
  startingAfter?: string;
  search?: string;
}

export function useEndUsers(params?: EndUserListParams) {
  const scope = useOrgScope();
  return $api.useQuery(
    "get",
    "/api/end-users",
    {
      params: {
        query: {
          limit: params?.limit,
          startingAfter: params?.startingAfter,
          search: params?.search,
        },
        header: scope.header,
      },
    },
    { enabled: scope.enabled },
  );
}

export function useEndUser(endUserId: string) {
  const scope = useOrgScope();
  return $api.useQuery(
    "get",
    "/api/end-users/{id}",
    { params: { path: { id: endUserId }, header: scope.header } },
    { enabled: scope.enabled && !!endUserId },
  );
}

/**
 * openapi-react-query keys are [method, path, init] with the literal spec
 * path — list and detail live under different path strings, so both need
 * invalidating after a write.
 */
function useInvalidateEndUsers() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["get", "/api/end-users"] });
    void qc.invalidateQueries({ queryKey: ["get", "/api/end-users/{id}"] });
  };
}

export function useCreateEndUser() {
  const invalidate = useInvalidateEndUsers();
  return $api.useMutation("post", "/api/end-users", { onSuccess: invalidate });
}

export function useUpdateEndUser() {
  const invalidate = useInvalidateEndUsers();
  return $api.useMutation("patch", "/api/end-users/{id}", { onSuccess: invalidate });
}

export function useDeleteEndUser() {
  const invalidate = useInvalidateEndUsers();
  return $api.useMutation("delete", "/api/end-users/{id}", { onSuccess: invalidate });
}
