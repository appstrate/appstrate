// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect } from "react";
import { useLocation } from "react-router-dom";
import { useStore } from "zustand";
import { authStore } from "../stores/auth-store";
import { orgStore } from "../stores/org-store";
import { overviewStore } from "../stores/overview-store";
import { rememberedSpaceKey } from "../stores/space-store";
import { routeOf } from "../lib/route-match";
import { holdsOverview, overviewModeOn, overviewOffered } from "../lib/space-lists";
import { useSpaces } from "./use-spaces";

/**
 * « Vue d'ensemble »: a mode of the shell chosen in the switcher, laid over the working space
 * (which stays a real space). The one answer to "is it on" — nothing re-derives it. `choose`
 * writes the reader's choice in an org, the current one by default.
 */
export function useOverviewMode() {
  const userId = useStore(authStore, (s) => s.user?.id);
  const orgId = useStore(orgStore, (s) => s.id);
  const key = userId && orgId ? rememberedSpaceKey(userId, orgId) : null;
  const chosen = useStore(overviewStore, (s) => !!key && !!s.chosen[key]);
  const { data: spaces } = useSpaces();

  const choose = useCallback(
    (on: boolean, inOrgId = orgId) => {
      if (userId && inOrgId) overviewStore.getState().set(rememberedSpaceKey(userId, inOrgId), on);
    },
    [userId, orgId],
  );

  return { on: overviewModeOn(chosen, spaces), offered: overviewOffered(spaces), choose };
}

/** Leaves the mode when the page on screen belongs to one space (`holdsOverview`). Render inside MainLayout. */
export function useOverviewRouteRule(): void {
  const { pathname } = useLocation();
  const { on, choose } = useOverviewMode();
  const holds = holdsOverview(routeOf(pathname));
  useEffect(() => {
    if (on && !holds) choose(false);
  }, [on, holds, choose]);
}
