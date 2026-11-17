// SPDX-License-Identifier: Apache-2.0

import { useCallback } from "react";
import { usePermissions } from "./use-permissions";
import { useAppConfig } from "./use-app-config";
import { useOverviewMode } from "./use-overview-mode";
import { useSpaces } from "./use-spaces";
import { useOrg } from "./use-org";
import { useCurrentSpaceId } from "./use-current-space";
import { routeVerdict, type RoutePath } from "../lib/route-access";
import { routeOf } from "../lib/route-match";
import { grantsInRowSpace, spanningRouteVerdict } from "../lib/space-lists";

/**
 * The verdict on a declared route, read by `RouteGate` and every link: the working space's
 * permissions, except a route spanning spaces: the chat in every mode, a list and its rows in « Tous les espaces »,
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

/**
 * {@link useCanReach} judged in a row's space rather than the working one: what a link of a list
 * spanning spaces opens once it has entered the row's space (`?enterSpace=`). A row of no space,
 * or of the working space, is {@link useCanReach}'s.
 */
export function useCanReachInSpace(): (target: string, spaceId: string | undefined) => boolean {
  const canReach = useCanReach();
  const { can } = usePermissions();
  const { features } = useAppConfig();
  const workingSpaceId = useCurrentSpaceId();
  const { data: spaces } = useSpaces();
  const orgPermissions = useOrg().currentOrg?.permissions;
  return useCallback(
    (target: string, spaceId: string | undefined) => {
      const route = routeOf(target);
      if (!route || !spaceId || spaceId === workingSpaceId) return canReach(target);
      const space = spaces?.find((s) => s.id === spaceId);
      if (!space) return false;
      const gate = (permission: string) =>
        grantsInRowSpace(spaceId, workingSpaceId, can, spaces, orgPermissions, permission);
      return routeVerdict(route, gate, features, space.personal) === "granted";
    },
    [canReach, can, features, workingSpaceId, spaces, orgPermissions],
  );
}

/** Whether the reach verdicts are answers yet: until the permission set loads every one reads as refused. */
export function useReachReady(): boolean {
  return usePermissions().ready;
}
