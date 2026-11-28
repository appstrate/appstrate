// SPDX-License-Identifier: Apache-2.0

import * as React from "react";

/**
 * How an activity group draws its parts (`activity-group.tsx`): as steps under its rail, or as
 * what stays in view whatever the fold. `solo`: the group's one step, a reasoning, which the
 * group's header names: drawn without a line of its own, its text straight under the header. A
 * lone call draws no step: the group's line is that call's line. Outside a group, `null`.
 */
export interface ActivityMode {
  readonly mode: "step" | "breakout";
  readonly solo: boolean;
}

export const ActivityModeContext = React.createContext<ActivityMode | null>(null);

export function useActivityMode(): ActivityMode | null {
  return React.useContext(ActivityModeContext);
}
