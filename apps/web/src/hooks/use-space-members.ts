// SPDX-License-Identifier: Apache-2.0

import { useQueryClient, type MutationMeta } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { $api, type components } from "../api/client";
import { invalidateIntegrationQueries } from "./use-integrations";
import { useOrgOnlyScope } from "./use-org-scope";
import { spaceRoleAssignment, useInvalidateRoles, type SpaceRoleOption } from "./use-roles";

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

function useUpdateSpaceMember() {
  const invalidate = useInvalidateRoles();
  return $api.useMutation("patch", "/api/spaces/{id}/members/{userId}", { onSuccess: invalidate });
}

/**
 * Gives a person a role in a space from one control, two routes: an explicit
 * seat is PATCHed, an implicit member (open space) has no row yet, so picking
 * a role CREATES one — `PATCH` 404s without a row, so the branch is the API's.
 * Toasts the result under `name`, the space's or the person's.
 */
export function useAssignSpaceRole(roleOptions: SpaceRoleOption[]) {
  const { t } = useTranslation("settings");
  const addMember = useAddSpaceMember();
  const updateMember = useUpdateSpaceMember();

  const assign = (
    { spaceId, member, name }: { spaceId: string; member: SpaceMemberObject; name: string },
    value: string,
  ) => {
    const body = spaceRoleAssignment(value);
    const onSuccess = () =>
      toast.success(
        t("spaceMembers.roleUpdated", {
          name,
          role: roleOptions.find((option) => option.value === value)?.label ?? value,
        }),
      );
    if (member.source === "explicit") {
      updateMember.mutate(
        { params: { path: { id: spaceId, userId: member.userId } }, body },
        { onSuccess },
      );
      return;
    }
    addMember.mutate(
      { params: { path: { id: spaceId } }, body: { userId: member.userId, ...body } },
      { onSuccess },
    );
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
