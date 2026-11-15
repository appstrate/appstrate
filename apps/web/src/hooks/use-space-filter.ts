// SPDX-License-Identifier: Apache-2.0

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { useStore } from "zustand";
import type { ScopeSpec } from "../components/list-toolbar";
import { readList } from "../lib/list-params";
import { spaceLabel } from "../lib/space-label";
import { allSpacesStore } from "../stores/all-spaces-store";
import { authStore } from "../stores/auth-store";
import { orgStore } from "../stores/org-store";
import { rememberedSpaceKey } from "../stores/space-store";
import { isSpaceEnterable, useCurrentSpaceId } from "./use-current-space";
import { useSpaces } from "./use-spaces";

const PARAM = "spaceId";

/** Whether a space's effective permission set admits the list. */
export type AdmitsList = (permissions: readonly string[]) => boolean;

interface ListedSpace {
  id: string;
  access: string;
  permissions: readonly string[];
}

/**
 * The spaces a list may span, and the ones it spans. Offered: held with a role (a listed space
 * without one is a 400 on the org route) where the list's permission holds; none below two.
 * Spanned: the URL's `spaceId` when present (stale ids dropped), else every offered space when
 * the reader keeps "all spaces", else none — the current space's own route. The current space
 * alone is none too. Exported for its test.
 */
export function spaceSelection<S extends ListedSpace>(
  spaces: readonly S[] | undefined,
  raw: string | null,
  admits: AdmitsList,
  currentSpaceId: string | null,
  rememberAll: boolean,
): { offered: S[]; selected: S[] } {
  const admitting = (spaces ?? []).filter(
    (space) => isSpaceEnterable(space) && admits(space.permissions),
  );
  const offered = admitting.length >= 2 ? admitting : [];
  if (raw === null) return { offered, selected: rememberAll ? offered : [] };
  const ticked = new Set(
    readList(
      raw,
      offered.map((space) => space.id),
    ),
  );
  const selected = offered.filter((space) => ticked.has(space.id));
  const currentOnly = selected.length === 1 && selected[0]?.id === currentSpaceId;
  return { offered, selected: currentOnly ? [] : selected };
}

/** What the URL keeps of a tick: listing order, nothing when it is the current space alone. Exported for its test. */
export function storedSpaceIds(
  ticked: readonly string[],
  offered: readonly { id: string }[],
  currentSpaceId: string | null,
): string[] {
  const ids = offered.filter((space) => ticked.includes(space.id)).map((space) => space.id);
  return ids.length === 1 && ids[0] === currentSpaceId ? [] : ids;
}

/**
 * The « Espace » scope of a list (runs, schedules, files): absent below two admitting spaces.
 * It lives in the URL (`?spaceId=`), outside the page's filters and their reset. Choosing every
 * space is remembered per account and org and opens the next list on every space; any other
 * choice forgets it (a remembered partial list would exclude the space the reader moves to).
 */
export function useSpaceFilter(admits: AdmitsList) {
  const { t } = useTranslation(["common"]);
  const [params, setParams] = useSearchParams();
  const raw = params.get(PARAM);
  const { data: spaces } = useSpaces();
  const currentSpaceId = useCurrentSpaceId();
  const userId = useStore(authStore, (s) => s.user?.id);
  const orgId = useStore(orgStore, (s) => s.id);
  const key = userId && orgId ? rememberedSpaceKey(userId, orgId) : null;
  const rememberAll = useStore(allSpacesStore, (s) => !!key && !!s.remembered[key]);
  const { offered, selected } = spaceSelection(spaces, raw, admits, currentSpaceId, rememberAll);
  const offeredIds = offered.map((space) => space.id).join(",");

  // The remembered choice already spans (one request); the URL follows so the list stays a link.
  const syncUrl = raw === null && rememberAll && offeredIds !== "";
  useEffect(() => {
    if (!syncUrl) return;
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set(PARAM, offeredIds);
        return next;
      },
      { replace: true },
    );
  }, [syncUrl, offeredIds, setParams]);

  const choose = (ticked: string[]) => {
    const ids = storedSpaceIds(ticked, offered, currentSpaceId);
    if (key) allSpacesStore.getState().set(key, ids.length === offered.length);
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (ids.length === 0) next.delete(PARAM);
      else next.set(PARAM, ids.join(","));
      return next;
    });
  };

  const scope: ScopeSpec | undefined =
    offered.length > 0
      ? {
          id: PARAM,
          label: t("toolbar.space"),
          values: selected.map((space) => space.id),
          implicit: offered.filter((space) => space.id === currentSpaceId).map((space) => space.id),
          allLabel: t("toolbar.allSpaces"),
          options: offered.map((space) => ({ value: space.id, label: spaceLabel(space, t) })),
          onChange: choose,
        }
      : undefined;
  return { spaceIds: selected.map((space) => space.id), selected, scope };
}
