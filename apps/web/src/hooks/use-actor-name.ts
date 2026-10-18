// SPDX-License-Identifier: Apache-2.0

import { endUserLabel, memberLabel } from "../lib/members";
import type { ActorValue } from "../lib/schedule-payload";
import { useOrgDetail } from "./use-org";
import { useEndUser, type EndUserInfo } from "./use-end-users";

/**
 * The name of the actor a value designates: a member from the organization's list, an end-user
 * from `listed` when a page already holds it, else from its own read. The id stands in while the
 * name is unread (`resolving` says it is still on its way); `name` is `null` for no actor.
 */
export function useActor(
  value: ActorValue | undefined,
  listed: readonly EndUserInfo[] = [],
): { name: string | null; resolving: boolean } {
  const orgQuery = useOrgDetail();
  const { data: orgData } = orgQuery;
  const listedEndUser = value?.endUserId
    ? listed.find((eu) => eu.id === value.endUserId)
    : undefined;
  const endUserQuery = useEndUser(value?.endUserId && !listedEndUser ? value.endUserId : "");
  if (value?.userId) {
    const m = orgData?.members?.find((mm) => mm.userId === value.userId);
    return m
      ? { name: memberLabel(m), resolving: false }
      : { name: value.userId, resolving: orgQuery.isLoading };
  }
  if (value?.endUserId) {
    const endUser = listedEndUser ?? endUserQuery.data;
    return endUser
      ? { name: endUserLabel(endUser, endUser.id), resolving: false }
      : { name: value.endUserId, resolving: endUserQuery.isLoading };
  }
  return { name: null, resolving: false };
}

/** {@link useActor}'s name alone, for a caller that can live with the id standing in. */
export function useActorName(
  value: ActorValue | undefined,
  listed: readonly EndUserInfo[] = [],
): string | null {
  return useActor(value, listed).name;
}
