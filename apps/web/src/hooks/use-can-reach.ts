// SPDX-License-Identifier: Apache-2.0

import { useCallback } from "react";
import { usePermissions, useRowSpaceGrants } from "./use-permissions";
import { useAppConfig } from "./use-app-config";
import { useOverviewMode } from "./use-overview-mode";
import { useSpaces } from "./use-spaces";
import { useSpaceLink } from "./use-current-space";
import { routeVerdict, STUDIO_PERMISSION, type RoutePath } from "../lib/route-access";
import { routeOf } from "../lib/route-match";
import { homeOf } from "../lib/home-route";
import { grantedInSomeActingSpace, spacesWhere, spanningRouteVerdict } from "../lib/space-lists";

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
 * spanning spaces opens once it has entered the row's space (`?enterSpace=`). A row of no space
 * is judged by {@link useCanReach}.
 */
export function useCanReachInSpace(): (target: string, spaceId: string | undefined) => boolean {
  const canReach = useCanReach();
  const grants = useRowSpaceGrants();
  const { features } = useAppConfig();
  const { data: spaces } = useSpaces();
  return useCallback(
    (target: string, spaceId: string | undefined) => {
      const route = routeOf(target);
      if (!route || !spaceId) return canReach(target);
      const space = spaces?.find((s) => s.id === spaceId);
      if (!space) return false;
      const gate = (permission: string) => grants(spaceId, permission);
      return routeVerdict(route, gate, features, space.personal) === "granted";
    },
    [canReach, grants, features, spaces],
  );
}

/**
 * The link to `path` in a row's space, entering it when it is not the working one, or `undefined`
 * where the page does not open for the reader: judged in the row's space, or in « Tous les
 * espaces » where some space admits it.
 */
export function useReachableSpaceLink(): (
  path: string,
  spaceId: string | undefined,
) => string | undefined {
  const spaceLink = useSpaceLink();
  const canReach = useCanReach();
  const canReachInSpace = useCanReachInSpace();
  const { on } = useOverviewMode();
  return useCallback(
    (path, spaceId) =>
      (on ? canReach(path) : canReachInSpace(path, spaceId)) ? spaceLink(path, spaceId) : undefined,
    [on, canReach, canReachInSpace, spaceLink],
  );
}

/** Whether the reader reaches the Studio: in the working space, or in « Tous les espaces » in some space. */
export function useStudioReach(): boolean {
  const { can } = usePermissions();
  const { on } = useOverviewMode();
  const { data: spaces } = useSpaces();
  return (
    can(STUDIO_PERMISSION) ||
    (on && spacesWhere(spaces, (grant) => grant(STUDIO_PERMISSION)).length > 0)
  );
}

/** Whether the reach verdicts are answers yet: until the permission set loads every one reads as refused. */
export function useReachReady(): boolean {
  return usePermissions().ready;
}

/**
 * What `/` shows the reader (`homeOf`): the chat where it opens, for a role with the Studio only
 * where it may also write there (a read-only chat only rereads past sessions), judged across the
 * acting spaces once their listing answers; else the dashboard, a refusal, or pending.
 */
export function useHome() {
  const { ready } = usePermissions();
  const { data: spaces, isPending } = useSpaces();
  const studio = useStudioReach();
  const reachable = useCanReach()("/chat");
  // The listing also decides the Studio in « Tous les espaces »: wait for it.
  const chat =
    reachable && isPending
      ? undefined
      : reachable && (!studio || grantedInSomeActingSpace(spaces, "chat:write"));
  return homeOf({ ready, studio, chat });
}
