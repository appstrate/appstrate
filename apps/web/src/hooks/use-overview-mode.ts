// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect } from "react";
import { useLocation } from "react-router-dom";
import { useStore } from "zustand";
import { authStore } from "../stores/auth-store";
import { orgStore } from "../stores/org-store";
import { overviewStore } from "../stores/overview-store";
import { rememberedSpaceKey } from "../stores/space-store";
import { routeOf } from "../lib/route-match";
import {
  admittingSpaces,
  holdsOverview,
  listAdmits,
  overviewLapsed,
  overviewOffered,
  type SpaceList,
} from "../lib/space-lists";
import { useSpaces } from "./use-spaces";

/** Where the reader's choice is kept in the current org: per account and org; null before both. */
function useChoiceKey(): string | null {
  const userId = useStore(authStore, (s) => s.user?.id);
  const orgId = useStore(orgStore, (s) => s.id);
  return userId && orgId ? rememberedSpaceKey(userId, orgId) : null;
}

/**
 * « Vue d'ensemble »: a mode of the shell chosen in the switcher, laid over the working space
 * (which stays a real space). The one answer to "is it on" — nothing re-derives it: on while the
 * reader chose it AND it is offered. `known` once the space listing has answered (or failed):
 * before, `on` reads false. `choose` writes the reader's choice in an org, the current one by
 * default.
 *
 * A list PAGE reads `on` and passes it to its hooks as `spanning`, which reads the org routes;
 * a shared hook never reads it, since a detail page runs in one space while the mode is on. The
 * mode hides nothing: an action takes the row's space or asks for one (`useSpaceAction`).
 */
export function useOverviewMode() {
  const userId = useStore(authStore, (s) => s.user?.id);
  const orgId = useStore(orgStore, (s) => s.id);
  const key = useChoiceKey();
  const chosen = useStore(overviewStore, (s) => !!key && !!s.chosen[key]);
  const { data: spaces, isError } = useSpaces();

  const choose = useCallback(
    (on: boolean, inOrgId = orgId) => {
      if (userId && inOrgId) overviewStore.getState().set(rememberedSpaceKey(userId, inOrgId), on);
    },
    [userId, orgId],
  );

  const on = chosen && overviewOffered(spaces);
  const known = spaces !== undefined || isError;
  return { on, known, choose };
}

/**
 * The spaces that admit `list`: where a list spanning spaces finds its rows, judged by each
 * row's space rather than the working one.
 */
export function useAdmittingSpaces(list: SpaceList) {
  const { data: spaces } = useSpaces();
  return admittingSpaces(spaces, listAdmits(list));
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
