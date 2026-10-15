// SPDX-License-Identifier: Apache-2.0

import { keepPreviousData, useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { $api, client, type components } from "../api/client";
import { keysetPaging } from "../lib/keyset-paging";
import { invalidatePaths } from "../lib/query-keys";
import { useOrgScope } from "./use-org-scope";
import { usePermissions } from "./use-permissions";

/** Wire shape from the OpenAPI spec (components.schemas.EndUserObject). */
export type EndUserInfo = components["schemas"]["EndUserObject"];

interface EndUserListParams {
  limit?: number;
  search?: string;
}

/** `end-users:read`, which the schedule form's actor picker does not imply. */
function useEndUsersReadScope() {
  const scope = useOrgScope();
  const { can } = usePermissions();
  return { header: scope.header, enabled: scope.enabled && can("end-users:read") };
}

export function useEndUsers(params?: EndUserListParams) {
  const scope = useEndUsersReadScope();
  return $api.useQuery(
    "get",
    "/api/end-users",
    {
      params: {
        query: {
          limit: params?.limit,
          search: params?.search,
        },
        header: scope.header,
      },
    },
    { enabled: scope.enabled },
  );
}

/**
 * The end-users, keyset-paged (`startingAfter` = last id seen) and searched server-side. The key
 * keeps the `[method, path]` prefix so the write invalidations reach it, and the extra segment
 * keeps it apart from `useEndUsers`'s plain pages; a refetch re-reads every loaded page.
 */
export function useEndUsersPaged({ search }: { search?: string } = {}) {
  const scope = useEndUsersReadScope();
  const query = { limit: 25, search: search?.trim() || undefined };
  return useInfiniteQuery({
    queryKey: ["get", "/api/end-users", "paged", { header: scope.header, query }] as const,
    queryFn: async ({ pageParam, signal }) => {
      const { data } = await client.GET("/api/end-users", {
        params: { query: { ...query, startingAfter: pageParam }, header: scope.header },
        signal,
      });
      if (!data) throw new Error("empty response");
      return data;
    },
    ...keysetPaging,
    placeholderData: keepPreviousData,
    enabled: scope.enabled,
  });
}

export function useEndUser(endUserId: string) {
  const scope = useEndUsersReadScope();
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
  return () => invalidatePaths(qc, ["/api/end-users", "/api/end-users/{id}"]);
}

export function useCreateEndUser() {
  const invalidate = useInvalidateEndUsers();
  return $api.useMutation("post", "/api/end-users", {
    meta: { errorHandledByCaller: true },
    onSuccess: () => {
      void invalidate();
    },
  });
}

export function useUpdateEndUser() {
  const invalidate = useInvalidateEndUsers();
  return $api.useMutation("patch", "/api/end-users/{id}", {
    meta: { errorHandledByCaller: true },
    onSuccess: invalidate,
  });
}

export function useDeleteEndUser() {
  const invalidate = useInvalidateEndUsers();
  return $api.useMutation("delete", "/api/end-users/{id}", {
    onSuccess: () => {
      void invalidate();
    },
  });
}
