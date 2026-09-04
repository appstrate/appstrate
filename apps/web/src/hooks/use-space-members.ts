// SPDX-License-Identifier: Apache-2.0

import { useQueryClient } from "@tanstack/react-query";
import { $api, type components } from "../api/client";
import { useOrgOnlyScope } from "./use-org-scope";

export type SpaceMemberObject = components["schemas"]["SpaceMemberObject"];

/**
 * Everyone who actually reaches the space: explicit rows, org owners/admins
 * (`source: "org_role"`) and, in an `open` space, every org member
 * (`source: "open_space"`).
 */
export function useSpaceMembers(spaceId: string) {
  const scope = useOrgOnlyScope();
  return $api.useQuery(
    "get",
    "/api/spaces/{id}/members",
    { params: { path: { id: spaceId }, header: scope.header } },
    { enabled: scope.enabled && !!spaceId, select: (e) => e.data },
  );
}

/**
 * A membership write changes the caller's own effective set when they edit
 * their own row, and always changes the member list — invalidate both. The
 * space list carries `permissions` per space, so it is not optional.
 */
function useInvalidateSpaceMembers() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["get", "/api/spaces/{id}/members"] });
    void qc.invalidateQueries({ queryKey: ["get", "/api/spaces"] });
  };
}

export function useAddSpaceMember() {
  const invalidate = useInvalidateSpaceMembers();
  return $api.useMutation("post", "/api/spaces/{id}/members", { onSuccess: invalidate });
}

export function useUpdateSpaceMember() {
  const invalidate = useInvalidateSpaceMembers();
  return $api.useMutation("patch", "/api/spaces/{id}/members/{userId}", {
    onSuccess: invalidate,
  });
}

export function useRemoveSpaceMember() {
  const invalidate = useInvalidateSpaceMembers();
  return $api.useMutation("delete", "/api/spaces/{id}/members/{userId}", {
    onSuccess: invalidate,
  });
}
