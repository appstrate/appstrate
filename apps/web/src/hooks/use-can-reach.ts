// SPDX-License-Identifier: Apache-2.0

import { useCallback } from "react";
import { usePermissions } from "./use-permissions";
import { useAppConfig } from "./use-app-config";
import { routeVerdict } from "../lib/route-access";
import { routeOf } from "../lib/route-match";

/**
 * Whether a link to `target` — a declared route or a concrete URL — lands on a
 * page `RouteGate` opens. A URL outside every declaration is not gated here.
 */
export function useCanReach(): (target: string) => boolean {
  const { can } = usePermissions();
  const { features } = useAppConfig();
  return useCallback(
    (target: string) => {
      const route = routeOf(target);
      return !route || routeVerdict(route, can, features) === "granted";
    },
    [can, features],
  );
}
