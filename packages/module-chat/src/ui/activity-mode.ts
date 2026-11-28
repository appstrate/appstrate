// SPDX-License-Identifier: Apache-2.0

import * as React from "react";

/**
 * How an activity group draws its parts (`activity-group.tsx`): as steps under its rail, or as
 * what stays in view whatever the fold. `solo`: the group's one step, opened with it. Outside a
 * group, `null`.
 */
export interface ActivityMode {
  readonly mode: "step" | "breakout";
  readonly solo: boolean;
}

export const ActivityModeContext = React.createContext<ActivityMode | null>(null);

export function useActivityMode(): ActivityMode | null {
  return React.useContext(ActivityModeContext);
}
