// SPDX-License-Identifier: Apache-2.0

import { useQueryClient, type MutationMeta } from "@tanstack/react-query";
import { $api, type components } from "../api/client";
import { invalidateIntegrationQueries } from "./use-integrations";
import { useOrgOnlyScope } from "./use-org-scope";
import { spaceRoleAssignment, useInvalidateRoles } from "./use-roles";

export type SpaceMemberObject = components["schemas"]["SpaceMemberObject"];
/** What a seat control reads of a person in a space: who, how they reach it, and as what. */
export type SpaceSeat = Pick<SpaceMemberObject, "userId" | "org_role" | "source" | "role">;

/** Everyone who reaches the space: explicit rows, org owners/admins (`org_role`) and, by default, every org member of an `open` space or the owner of a personal space (`open_space`). */
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

function useUpdateSpaceMember() {
  const invalidate = useInvalidateRoles();
  return $api.useMutation("patch", "/api/spaces/{id}/members/{userId}", { onSuccess: invalidate });
}

/** One control, two routes: an explicit seat is PATCHed; an implicit member (open space) has no row, and `PATCH` 404s without one, so picking a role CREATES it. */
export function useAssignSpaceRole() {
  const addMember = useAddSpaceMember();
  const updateMember = useUpdateSpaceMember();

  const assign = ({ spaceId, member }: { spaceId: string; member: SpaceSeat }, value: string) => {
    const body = spaceRoleAssignment(value);
    if (member.source === "explicit") {
      updateMember.mutate({ params: { path: { id: spaceId, userId: member.userId } }, body });
      return;
    }
    addMember.mutate({
      params: { path: { id: spaceId } },
      body: { userId: member.userId, ...body },
    });
  };

  return { assign, isPending: addMember.isPending || updateMember.isPending };
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
