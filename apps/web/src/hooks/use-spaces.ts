// SPDX-License-Identifier: Apache-2.0

import { useQueryClient } from "@tanstack/react-query";
import { $api } from "../api/client";
import { useOrgOnlyScope } from "./use-org-scope";

export function useSpaces() {
  const scope = useOrgOnlyScope();
  return $api.useQuery(
    "get",
    "/api/spaces",
    { params: { header: scope.header } },
    { enabled: scope.enabled, select: (e) => e.data },
  );
}

export function useSpace(spaceId: string) {
  const scope = useOrgOnlyScope();
  return $api.useQuery(
    "get",
    "/api/spaces/{id}",
    { params: { path: { id: spaceId }, header: scope.header } },
    { enabled: scope.enabled && !!spaceId },
  );
}

/**
 * openapi-react-query keys are [method, path, init] with the literal spec
 * path — list and detail live under different path strings, so both need
 * invalidating after a write.
 */
function useInvalidateSpaces() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["get", "/api/spaces"] });
    void qc.invalidateQueries({ queryKey: ["get", "/api/spaces/{id}"] });
  };
}

export function useCreateSpace() {
  const invalidate = useInvalidateSpaces();
  return $api.useMutation("post", "/api/spaces", { onSuccess: invalidate });
}

export function useUpdateSpace() {
  const invalidate = useInvalidateSpaces();
  return $api.useMutation("patch", "/api/spaces/{id}", { onSuccess: invalidate });
}

export function useDeleteSpace() {
  const invalidate = useInvalidateSpaces();
  return $api.useMutation("delete", "/api/spaces/{id}", { onSuccess: invalidate });
}
