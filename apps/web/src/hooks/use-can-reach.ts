// SPDX-License-Identifier: Apache-2.0

import { useCallback } from "react";
import { usePermissions, useRowSpaceGrants } from "./use-permissions";
import { useAppConfig } from "./use-app-config";
import { useOverviewMode } from "./use-overview-mode";
import { useSpaces } from "./use-spaces";
import { useSpaceLink } from "./use-current-space";
import { holdsStudio, routeVerdict, type RoutePath } from "../lib/route-access";
import { routeOf } from "../lib/route-match";
import { runDetailPath } from "../lib/package-paths";
import { homeOf } from "../lib/home-route";
import { spacesWhere, spanningRouteVerdict } from "../lib/space-lists";

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
 * where the page does not open for the reader: judged in the row's space ({@link useCanReachInSpace}:
 * a role without the Studio gets no link into it), or in « Tous les espaces », which keeps the mode
 * on such a page, where some space admits it ({@link useCanReach}). The one rule of every link a
 * row or the chat draws into a space's page.
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

/** A run's page, in the run's space: `undefined` for a run with no agent left to live under, or whose page does not open for the reader. */
export function useRunPageHref(run: {
  id: string;
  packageId?: string | null;
  spaceId?: string;
}): string | undefined {
  const link = useReachableSpaceLink();
  return run.packageId ? link(runDetailPath(run.packageId, run.id), run.spaceId) : undefined;
}

/**
 * Whether the reader reaches the Studio: the working space grants it, or in « Tous les espaces »
 * some space does, as the mode's lists open where one admits them.
 */
export function useStudioReach(): boolean {
  const { can } = usePermissions();
  const { on } = useOverviewMode();
  const { data: spaces } = useSpaces();
  return holdsStudio(can) || (on && spacesWhere(spaces, holdsStudio).length > 0);
}

/** Whether the reach verdicts are answers yet: until the permission set loads every one reads as refused. */
export function useReachReady(): boolean {
  return usePermissions().ready;
}

/** What `/` shows the reader (`homeOf`): the dashboard, the chat, a refusal, or pending. */
export function useHome() {
  const { ready } = usePermissions();
  const studio = useStudioReach();
  const chat = useCanReach()("/chat");
  return homeOf({ ready, studio, chat });
}
