// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import type { ScopeSpec } from "../components/list-toolbar";
import { readList } from "../lib/list-params";
import { admittingSpaces, type AdmitsList } from "../lib/space-lists";
import { spaceLabel } from "../lib/space-label";
import { useCurrentSpaceId } from "./use-current-space";
import { useOverviewMode } from "./use-overview-mode";
import { useSpaces } from "./use-spaces";

const PARAM = "spaceId";

interface ListedSpace {
  id: string;
  access: string;
  permissions: readonly string[];
}

/**
 * The spaces a list may span, and the ones it spans (empty: the current space's own route).
 * Out of « Vue d'ensemble », they are offered from two admitting spaces and the list spans the
 * URL's `spaceId` (stale ids dropped, the current space alone meaning none). In the mode, every
 * admitting space is offered and the list spans the URL's narrowing, else all of them. Exported
 * for its test.
 */
export function spaceSelection<S extends ListedSpace>(
  spaces: readonly S[] | undefined,
  raw: string | null,
  admits: AdmitsList,
  currentSpaceId: string | null,
  overview: boolean,
): { offered: S[]; selected: S[] } {
  const admitting = admittingSpaces(spaces, admits);
  const ticked = new Set(
    readList(
      raw,
      admitting.map((space) => space.id),
    ),
  );
  const narrowed = admitting.filter((space) => ticked.has(space.id));
  if (overview) {
    return { offered: admitting, selected: narrowed.length > 0 ? narrowed : admitting };
  }
  const offered = admitting.length >= 2 ? admitting : [];
  const selected = offered.length > 0 ? narrowed : [];
  const currentOnly = selected.length === 1 && selected[0]?.id === currentSpaceId;
  return { offered, selected: currentOnly ? [] : selected };
}

/** What the URL keeps of a tick: listing order, nothing when it is the default. Exported for its test. */
export function storedSpaceIds(
  ticked: readonly string[],
  offered: readonly { id: string }[],
  currentSpaceId: string | null,
  overview: boolean,
): string[] {
  const ids = offered.filter((space) => ticked.includes(space.id)).map((space) => space.id);
  const isDefault = overview
    ? ids.length === offered.length
    : ids.length === 1 && ids[0] === currentSpaceId;
  return isDefault ? [] : ids;
}

/**
 * The « Espace » scope of a list (runs, schedules, files), carried by the URL (`?spaceId=`)
 * outside the page's filters and their reset. Drawn from two offered spaces. A list that spans
 * spaces (`spanning`) is read-only: a write acts in one space, which it does not name.
 */
export function useSpaceFilter(admits: AdmitsList) {
  const { t } = useTranslation(["common"]);
  const [params, setParams] = useSearchParams();
  const { data: spaces } = useSpaces();
  const currentSpaceId = useCurrentSpaceId();
  const { on: overview } = useOverviewMode();
  const { offered, selected } = spaceSelection(
    spaces,
    params.get(PARAM),
    admits,
    currentSpaceId,
    overview,
  );
  const ids = (list: readonly { id: string }[]) => list.map((space) => space.id);

  const choose = (ticked: string[]) => {
    const stored = storedSpaceIds(ticked, offered, currentSpaceId, overview);
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (stored.length === 0) next.delete(PARAM);
      else next.set(PARAM, stored.join(","));
      return next;
    });
  };

  const implicit = overview ? ids(offered) : ids(offered).filter((id) => id === currentSpaceId);
  const scope: ScopeSpec | undefined =
    offered.length >= 2
      ? {
          id: PARAM,
          label: t("toolbar.space"),
          values: ids(selected),
          implicit,
          allLabel: t("toolbar.allSpaces"),
          options: offered.map((space) => ({ value: space.id, label: spaceLabel(space, t) })),
          onChange: choose,
        }
      : undefined;
  return { spaceIds: ids(selected), selected, spanning: selected.length > 0, scope };
}
