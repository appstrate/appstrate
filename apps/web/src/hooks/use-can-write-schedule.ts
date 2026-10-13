// SPDX-License-Identifier: Apache-2.0

import { useAuth } from "./use-auth";
import { usePermissions } from "./use-permissions";
import { mayGovernScheduleActor } from "../lib/schedule-governance";

/** {@link mayGovernScheduleActor} for a loaded schedule; `false` while it is not. */
export function useCanWriteSchedule(
  schedule: { userId: string | null; endUserId: string | null } | undefined,
): boolean {
  const { user } = useAuth();
  const { orgRole } = usePermissions();
  return (
    !!schedule &&
    mayGovernScheduleActor(schedule.userId ?? schedule.endUserId, { userId: user?.id, orgRole })
  );
}
