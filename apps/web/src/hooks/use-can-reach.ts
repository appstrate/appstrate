// SPDX-License-Identifier: Apache-2.0

import { useCallback } from "react";
import { usePermissions } from "./use-permissions";
import { useAppConfig } from "./use-app-config";
import { routeVerdict, type RoutePath } from "../lib/route-access";

/** Whether a link to `path` lands on a page `RouteGate` opens — for nav entries and tabs. */
export function useCanReach(): (path: RoutePath) => boolean {
  const { can } = usePermissions();
  const { features } = useAppConfig();
  return useCallback(
    (path: RoutePath) => routeVerdict(path, can, features) === "granted",
    [can, features],
  );
}
