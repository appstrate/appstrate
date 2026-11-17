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
  holdsOverview,
  listAdmits,
  overviewLapsed,
  overviewOffered,
  spacesWhere,
  type SpaceList,
} from "../lib/space-lists";
import { useOrg } from "./use-org";
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
 * A list PAGE reads `on` and passes it to its data hooks as `spanning`, which reads the org
 * routes; a data hook never reads it, since a detail page runs in one space while the mode is on.
 * The verdicts and actions do (`useCanReach`, `useSpaceAction`): the mode hides nothing, an action
 * takes the row's space or asks for one.
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
  const orgPermissions = useOrg().currentOrg?.permissions;
  return spacesWhere(spaces, orgPermissions, listAdmits(list));
}

function withdraw(key: string): void {
  if (overviewStore.getState().chosen[key]) overviewStore.getState().set(key, false);
}

/** The page rule of {@link useOverviewRules}: rendering `pathname` withdraws the choice kept at `key` unless the page holds the mode. Exported for its test. */
export function withdrawOnPage(key: string, pathname: string): void {
  if (!holdsOverview(routeOf(pathname))) withdraw(key);
}

/** The listing rule of {@link useOverviewRules}: a listing proving the mode no longer offered withdraws it. Exported for its test. */
export function withdrawIfLapsed(key: string, spaces: Parameters<typeof overviewLapsed>[0]): void {
  if (overviewLapsed(spaces)) withdraw(key);
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
    if (key) withdrawOnPage(key, pathname);
  }, [key, pathname]);
  useEffect(() => {
    if (key) withdrawIfLapsed(key, spaces);
  }, [key, spaces]);
}
