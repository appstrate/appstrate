// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect } from "react";
import { useLocation } from "react-router-dom";
import { useStore } from "zustand";
import { authStore } from "../stores/auth-store";
import { orgStore } from "../stores/org-store";
import { overviewStore } from "../stores/overview-store";
import { rememberedSpaceKey } from "../stores/space-store";
import { routeOf } from "../lib/route-match";
import { holdsOverview, overviewLapsed, overviewModeOn, overviewOffered } from "../lib/space-lists";
import { useSpaces } from "./use-spaces";

/** Where the reader's choice is kept in the current org: per account and org; null before both. */
function useChoiceKey(): string | null {
  const userId = useStore(authStore, (s) => s.user?.id);
  const orgId = useStore(orgStore, (s) => s.id);
  return userId && orgId ? rememberedSpaceKey(userId, orgId) : null;
}

/**
 * « Vue d'ensemble »: a mode of the shell chosen in the switcher, laid over the working space
 * (which stays a real space). The one answer to "is it on" — nothing re-derives it. `choose`
 * writes the reader's choice in an org, the current one by default.
 */
export function useOverviewMode() {
  const userId = useStore(authStore, (s) => s.user?.id);
  const orgId = useStore(orgStore, (s) => s.id);
  const key = useChoiceKey();
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

function withdraw(key: string): void {
  if (overviewStore.getState().chosen[key]) overviewStore.getState().set(key, false);
}

/**
 * Withdraws the choice when the mode cannot stand: on reaching a page of one space
 * (`holdsOverview`), and once the listing proves it no longer offered (`overviewLapsed`), so a
 * space granted later does not bring it back. The page rule runs when the PAGE changes, never
 * when the choice does: choosing it on a page about to be left does not undo it. Render inside
 * MainLayout.
 */
export function useOverviewRules(): void {
  const { pathname } = useLocation();
  const key = useChoiceKey();
  const { data: spaces } = useSpaces();
  useEffect(() => {
    if (key && !holdsOverview(routeOf(pathname))) withdraw(key);
  }, [key, pathname]);
  useEffect(() => {
    if (key && overviewLapsed(spaces)) withdraw(key);
  }, [key, spaces]);
}
