// SPDX-License-Identifier: Apache-2.0

import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { FilterSpec } from "../components/list-toolbar";
import { SpaceTile } from "../components/space-name";
import type { SpaceList } from "../lib/space-lists";
import { spaceLabel } from "../lib/space-label";
import {
  nextSpaceParam,
  resolveSpaceFilter,
  SPACE_PARAM,
  TEAM_PRESET,
  withSpaceChoice,
} from "../lib/space-filter";
import { useAdmittingSpaces } from "./use-overview-mode";

/**
 * The space filter of a studio list in « Tous les espaces »: one dropdown holding the « Espaces
 * d'équipe » preset (the default) and, while it is not ticked, each space to pick. `filter` is null
 * where nothing is offered (see `resolveSpaceFilter`); `mode`, `spaceIds` and `runs` say what
 * narrows. The choice is pushed to history like the other filters, and a pick is cleared by a
 * page's `reset` (list the `space` key there).
 */
export function useSpaceFilter(list: SpaceList, spanning: boolean) {
  const { t } = useTranslation("common");
  const [params, setParams] = useSearchParams();
  const admitting = useAdmittingSpaces(list);
  const state = resolveSpaceFilter(
    spanning ? params.get(SPACE_PARAM) : null,
    spanning ? admitting : [],
  );

  const choose = (value: string | null) => setParams((prev) => withSpaceChoice(prev, value));

  const filter: FilterSpec | null = state.offered
    ? {
        id: SPACE_PARAM,
        label: t("spaceFilter.label"),
        options: [
          ...(state.preset ? [{ value: TEAM_PRESET, label: t("spaceFilter.team") }] : []),
          // A preset and individual spaces do not mix: the spaces appear once it is unticked.
          ...(state.mode === "team"
            ? []
            : admitting.map((space) => ({
                value: space.id,
                label: spaceLabel(space, t),
                icon: <SpaceTile space={space} />,
              }))),
        ],
        values: state.mode === "team" ? [TEAM_PRESET] : (state.spaceIds ?? []),
        ...(state.preset && { defaultValues: [TEAM_PRESET] }),
        onChange: (ticked) => choose(nextSpaceParam(ticked, state.preset)),
      }
    : null;

  return {
    filter,
    mode: state.mode,
    spaceIds: state.spaceIds,
    runs: state.runs,
    showAll: () => choose("all"),
  };
}
