// SPDX-License-Identifier: Apache-2.0

import { $api, type components } from "../api/client";
import { useOrgOnlyScope } from "./use-org-scope";
import { useInvalidateRoles } from "./use-roles";

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

export function useAddSpaceMember() {
  const invalidate = useInvalidateRoles();
  return $api.useMutation("post", "/api/spaces/{id}/members", { onSuccess: invalidate });
}

export function useUpdateSpaceMember() {
  const invalidate = useInvalidateRoles();
  return $api.useMutation("patch", "/api/spaces/{id}/members/{userId}", {
    onSuccess: invalidate,
  });
}

export function useRemoveSpaceMember() {
  const invalidate = useInvalidateRoles();
  return $api.useMutation("delete", "/api/spaces/{id}/members/{userId}", {
    onSuccess: invalidate,
  });
}
