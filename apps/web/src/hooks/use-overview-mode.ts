// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect } from "react";
import { useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { authStore } from "../stores/auth-store";
import { orgStore } from "../stores/org-store";
import { overviewStore } from "../stores/overview-store";
import { rememberedSpaceKey } from "../stores/space-store";
import { routeOf } from "../lib/route-match";
import {
  holdsOverview,
  listAdmitsOn,
  overviewOffered,
  spacesWhere,
  type ListSurface,
  type SpaceList,
} from "../lib/space-lists";
import { useSpaceLabelOf, useSpaces } from "./use-spaces";
import { useCurrentSpaceId } from "./use-current-space";

/** Where the reader's choice is kept in the current org: per account and org; null before both. */
function useChoiceKey(): string | null {
  const userId = useStore(authStore, (s) => s.user?.id);
  const orgId = useStore(orgStore, (s) => s.id);
  return userId && orgId ? rememberedSpaceKey(userId, orgId) : null;
}

/**
 * « Tous les espaces »: a mode laid over the working space, on while the reader chose it AND it is
 * offered; `known` once the space listing answered. A surface passes `on` to its data hooks as
 * `spanning`; a data hook never reads it itself. A row's detail page acts in the one space it was
 * opened in, and reads it to name that space, list across spaces, or ask where to act.
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
 * A sentence about the working space, its keys in `ns`: `plain` (« cet espace ») with a space
 * selected; in « Tous les espaces », where the page names it, `named` with that space as
 * `{{space}}`, and nothing until its name is known.
 */
export function useWorkingSpaceWording(ns: string) {
  const { t } = useTranslation(ns);
  const { on } = useOverviewMode();
  const space = useSpaceLabelOf()(useCurrentSpaceId());
  return (plain: string, named: string, options: Record<string, unknown> = {}): string =>
    !on ? t(plain, options) : space ? t(named, { ...options, space }) : "";
}

/**
 * The spaces that admit `list` on `surface`: where a list spanning spaces finds its rows, judged
 * by each row's space rather than the working one. The Studio's screens list only the spaces
 * opening the Studio; the chat lists every space granting the rows.
 */
export function useAdmittingSpaces(list: SpaceList, surface: ListSurface) {
  const { data: spaces } = useSpaces();
  return spacesWhere(spaces, listAdmitsOn(list, surface));
}

function withdraw(key: string): void {
  if (overviewStore.getState().chosen[key]) overviewStore.getState().set(key, false);
}

/** The page rule of {@link useOverviewRules}: rendering `pathname` withdraws the choice kept at `key` unless the page holds the mode. Exported for its test. */
export function withdrawOnPage(key: string, pathname: string): void {
  if (!holdsOverview(routeOf(pathname))) withdraw(key);
}

/**
 * Withdraws the choice on reaching a page of one space (`holdsOverview`). It runs when the PAGE
 * changes, never when the choice does: choosing it on a page about to be left does not undo it.
 * A mode no longer offered is simply off (`useOverviewMode`'s `on`). Render inside MainLayout.
 */
export function useOverviewRules(): void {
  const { pathname } = useLocation();
  const key = useChoiceKey();
  useEffect(() => {
    if (key) withdrawOnPage(key, pathname);
  }, [key, pathname]);
}

/**
 * The space a surface of no space (the catalogue) may call « ici »: the working space, except in
 * « Tous les espaces », where the working space is hidden and nothing is « here ».
 */
export function useHereSpaceId(): string | null {
  const { on } = useOverviewMode();
  const working = useCurrentSpaceId();
  return on ? null : working;
}
