// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import type { FilterSpec } from "../components/list-toolbar";
import type { ListState } from "../lib/list-params";
import { spaceLabel } from "../lib/space-label";
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
 * The spaces a list may span: held with a role (a listed space without one is a 400 on the org
 * route) where the list's permission holds (it grants nothing elsewhere). None below two: one
 * space is the page as it always was. `selected` is the URL read against them, empty when it
 * comes down to the current space alone: an id the reader no longer reaches is never sent, and
 * neither is the current space by itself (the space route serves it). Exported for its test.
 */
export function spaceSelection<S extends ListedSpace>(
  spaces: readonly S[] | undefined,
  list: Pick<ListState, "values">,
  admits: AdmitsList,
  currentSpaceId: string | null,
): { offered: S[]; selected: S[] } {
  const admitting = (spaces ?? []).filter(
    (space) => isSpaceEnterable(space) && admits(space.permissions),
  );
  const offered = admitting.length >= 2 ? admitting : [];
  const ticked = new Set(
    list.values(
      PARAM,
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
 * The « Espace » dimension of a list: absent (`filter` undefined) below two admitting spaces.
 * Untouched, it shows the current space ticked without filtering; a tick adds to it.
 */
export function useSpaceFilter(list: Pick<ListState, "values" | "setValues">, admits: AdmitsList) {
  const { t } = useTranslation(["common"]);
  const { data: spaces } = useSpaces();
  const currentSpaceId = useCurrentSpaceId();
  const { offered, selected } = spaceSelection(spaces, list, admits, currentSpaceId);
  const setValues = list.setValues(PARAM);
  const filter: FilterSpec | undefined =
    offered.length > 0
      ? {
          id: PARAM,
          label: t("toolbar.space"),
          values: selected.map((space) => space.id),
          implicit: offered.filter((space) => space.id === currentSpaceId).map((space) => space.id),
          selectAll: true,
          options: offered.map((space) => ({ value: space.id, label: spaceLabel(space, t) })),
          onChange: (ticked) => setValues(storedSpaceIds(ticked, offered, currentSpaceId)),
        }
      : undefined;
  return { spaceIds: selected.map((space) => space.id), selected, filter };
}
