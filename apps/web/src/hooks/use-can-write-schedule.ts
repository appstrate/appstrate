// SPDX-License-Identifier: Apache-2.0

import { useMemo } from "react";
import { useAuth } from "./use-auth";
import { usePermissions } from "./use-permissions";
import { mayGovernScheduleActor } from "../lib/schedule-governance";

/** What {@link mayGovernScheduleActor} asks about the signed-in caller. */
export function useScheduleCaller() {
  const { user } = useAuth();
  const { orgRole, can } = usePermissions();
  const userId = user?.id;
  const canCreateApiKeys = can("api-keys:create");
  return useMemo(
    () => ({ userId, orgRole, canCreateApiKeys }),
    [userId, orgRole, canCreateApiKeys],
  );
}

/** {@link mayGovernScheduleActor} for a loaded schedule; `false` while it is not. */
export function useCanWriteSchedule(
  schedule: { userId: string | null; endUserId: string | null } | undefined,
): boolean {
  const caller = useScheduleCaller();
  return !!schedule && mayGovernScheduleActor(schedule, caller);
}
