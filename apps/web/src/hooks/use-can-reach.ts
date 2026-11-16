// SPDX-License-Identifier: Apache-2.0

import { useCallback } from "react";
import { usePermissions } from "./use-permissions";
import { useAppConfig } from "./use-app-config";
import { useOverviewMode } from "./use-overview-mode";
import { useSpaces } from "./use-spaces";
import { routeVerdict, type RoutePath } from "../lib/route-access";
import { routeOf } from "../lib/route-match";
import { spanningRouteVerdict } from "../lib/space-lists";

/**
 * The verdict on a declared route, read by `RouteGate` and every link: the working space's
 * permissions, except a route spanning spaces: the chat in every mode, a list in « Vue d'ensemble »,
 * which open where some space admits them. A route the module does not load stays absent.
 */
export function useRouteVerdict() {
  const { can, inPersonalSpace } = usePermissions();
  const { features } = useAppConfig();
  const { on } = useOverviewMode();
  const { data: spaces } = useSpaces();
  return useCallback(
    (path: RoutePath) => {
      const own = routeVerdict(path, can, features, inPersonalSpace);
      return (own !== "absent" && spanningRouteVerdict(path, spaces, on)) || own;
    },
    [on, spaces, can, features, inPersonalSpace],
  );
}

/**
 * Whether a link to `target` — a declared route or a concrete URL — lands on a
 * page `RouteGate` opens. A URL outside every declaration is not gated here.
 */
export function useCanReach(): (target: string) => boolean {
  const verdict = useRouteVerdict();
  return useCallback(
    (target: string) => {
      const route = routeOf(target);
      return !route || verdict(route) === "granted";
    },
    [verdict],
  );
}

/** Whether the reach verdicts are answers yet: until the permission set loads every one reads as refused. */
export function useReachReady(): boolean {
  return usePermissions().ready;
}
