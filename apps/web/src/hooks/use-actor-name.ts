// SPDX-License-Identifier: Apache-2.0

import type { ActorValue } from "../lib/schedule-payload";
import { useOrgDetail } from "./use-org";
import { useEndUser, type EndUserInfo } from "./use-end-users";

/** Primary line for an option — name, falling back to email then id. */
export function primaryLabel(
  name: string | null | undefined,
  email: string | null,
  id: string,
): string {
  return name || email || id;
}

/**
 * The name of the actor a value designates: a member from the organization's list, an end-user
 * from `listed` when a page already holds it, else from its own read. The id stands in while the
 * name is unread; `null` for no actor.
 */
export function useActorName(
  value: ActorValue | undefined,
  listed: readonly EndUserInfo[] = [],
): string | null {
  const { data: orgData } = useOrgDetail();
  const listedEndUser = value?.endUserId
    ? listed.find((eu) => eu.id === value.endUserId)
    : undefined;
  const { data: readEndUser } = useEndUser(
    value?.endUserId && !listedEndUser ? value.endUserId : "",
  );
  if (value?.userId) {
    const m = orgData?.members?.find((mm) => mm.userId === value.userId);
    return m ? primaryLabel(m.displayName, m.email ?? null, m.userId) : value.userId;
  }
  if (value?.endUserId) {
    const endUser = listedEndUser ?? readEndUser;
    return endUser
      ? primaryLabel(endUser.name, endUser.email, endUser.externalId || endUser.id)
      : value.endUserId;
  }
  return null;
}
