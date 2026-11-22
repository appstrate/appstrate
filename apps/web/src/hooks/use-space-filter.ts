// SPDX-License-Identifier: Apache-2.0

import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { FilterSpec } from "../components/list-toolbar";
import type { SpaceList } from "../lib/space-lists";
import { resolveSpaceFilter } from "../lib/space-filter";
import { useAdmittingSpaces } from "./use-overview-mode";

const PARAM = "space";

/**
 * The space filter of a studio list in « Tous les espaces »: `?space=all` shows every space,
 * anything else the team spaces. `filter` is null where nothing is offered (see
 * `resolveSpaceFilter`); `spaceIds` is what narrows, `undefined` when nothing does. Pushed to
 * history like the other filters, and deliberately not part of a page's `reset`: clearing the
 * reader's filters keeps the widening they chose.
 */
export function useSpaceFilter(list: SpaceList, spanning: boolean) {
  const { t } = useTranslation("common");
  const [params, setParams] = useSearchParams();
  const admitting = useAdmittingSpaces(list);
  const state = resolveSpaceFilter(spanning ? params.get(PARAM) : null, spanning ? admitting : []);

  const setAll = (all: boolean) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (all) next.set(PARAM, "all");
      else next.delete(PARAM);
      return next;
    });

  const filter: FilterSpec | null = state.offered
    ? {
        id: PARAM,
        label: t("spaceFilter.label"),
        options: [{ value: "team", label: t("spaceFilter.team") }],
        values: state.all ? [] : ["team"],
        isDefault: !state.all,
        onChange: (values) => setAll(!values.includes("team")),
      }
    : null;

  return { filter, spaceIds: state.spaceIds, showAll: () => setAll(true) };
}
