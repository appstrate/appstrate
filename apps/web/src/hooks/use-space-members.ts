// SPDX-License-Identifier: Apache-2.0

import { useQueryClient, type MutationMeta } from "@tanstack/react-query";
import { $api, type components } from "../api/client";
import { invalidateIntegrationQueries } from "./use-integrations";
import { useOrgOnlyScope } from "./use-org-scope";
import { useInvalidateRoles } from "./use-roles";

export type SpaceMemberObject = components["schemas"]["SpaceMemberObject"];

/**
 * Everyone who actually reaches the space: explicit rows, org owners/admins
 * (`source: "org_role"`) and, in an `open` space, every org member
 * (`source: "open_space"`).
 */
export function useSpaceMembers(spaceId: string, enabled = true) {
  const scope = useOrgOnlyScope();
  return $api.useQuery(
    "get",
    "/api/spaces/{id}/members",
    { params: { path: { id: spaceId }, header: scope.header } },
    { enabled: scope.enabled && !!spaceId && enabled, select: (e) => e.data },
  );
}

/** `meta`: the add and share dialogs show a refusal on themselves; the role picker leaves it to the cache. */
export function useAddSpaceMember(meta?: MutationMeta) {
  const invalidate = useInvalidateRoles();
  return $api.useMutation("post", "/api/spaces/{id}/members", {
    meta,
    onSuccess: invalidate,
  });
}

export function useUpdateSpaceMember() {
  const invalidate = useInvalidateRoles();
  return $api.useMutation("patch", "/api/spaces/{id}/members/{userId}", { onSuccess: invalidate });
}

export function useRemoveSpaceMember() {
  const invalidate = useInvalidateRoles();
  const qc = useQueryClient();
  return $api.useMutation("delete", "/api/spaces/{id}/members/{userId}", {
    onSuccess: () => {
      invalidate();
      // The removal unshares the member's connections here once they lose access.
      void invalidateIntegrationQueries(qc);
    },
  });
}
