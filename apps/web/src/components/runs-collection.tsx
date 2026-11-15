// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { NoMatchState } from "./page-states";
import { ListToolbar, type FilterSpec } from "./list-toolbar";
import { RunList } from "./run-list";
import { useSearchPlaceholder } from "../lib/search-placeholder";
import { useListParams } from "../lib/list-params";
import { LIST_ADMITS } from "../lib/space-lists";
import type { RunKindFilter } from "../hooks/use-paginated-runs";
import { usePermissions } from "../hooks/use-permissions";
import { useRunStatusFilter } from "../hooks/use-run-status-filter";
import { useSpaceFilter, type SpaceDefault } from "../hooks/use-space-filter";

/**
 * Filters live in the URL (a filtered list is a link) and each takes SEVERAL
 * values. Kind and scope are narrower on the wire: squaring that with the
 * checkboxes is this file's job, so a tick means a tick on every menu.
 */
const KINDS = ["package", "inline"] as const;
const SCOPES = ["me"] as const;

/** The query parameters this list filters on, and nothing else. */
const FILTER_PARAMS = ["user", "kind", "status", "q"] as const;

/** The runs list with its bar: the Runs page's (current space) and the overview's (every space). */
export function RunsCollection({ spaceDefault }: { spaceDefault: SpaceDefault }) {
  const { t } = useTranslation(["agents", "common"]);
  const list = useListParams(FILTER_PARAMS);
  const searchPlaceholder = useSearchPlaceholder(t("common:nav.runs"));
  const { can } = usePermissions();
  // Spanned spaces list across them (org route); none is the current space, as always.
  const { spaceIds, selected: spaces, scope } = useSpaceFilter(LIST_ADMITS.runs, spaceDefault);
  // Without `runs:read-all` the list is already "mine": no scope filter. Across spaces, each
  // row follows its own space: "mine" narrows as soon as one of them shows others' runs.
  const canSeeEveryRun =
    spaces.length > 0
      ? spaces.some((space) => space.permissions.includes("runs:read-all"))
      : can("runs:read-all");

  const scopes = list.values("user", SCOPES);
  const kinds = list.values("kind", KINDS);
  const { statuses, filter: statusFilter } = useRunStatusFilter(list);
  const search = list.search;

  const filters: FilterSpec[] = [
    ...(canSeeEveryRun
      ? [
          {
            id: "user",
            label: t("runs.filterScope"),
            values: scopes,
            options: [{ value: "me", label: t("runs.filterMine") }],
            onChange: list.setValues("user"),
          },
        ]
      : []),
    {
      id: "kind",
      label: t("runs.filterKind"),
      values: kinds,
      options: [
        { value: "package", label: t("common:nav.agents") },
        { value: "inline", label: t("runs.inlineBadge") },
      ],
      onChange: list.setValues("kind"),
    },
    statusFilter,
  ];

  // The endpoint takes ONE kind, so "both ticked" is "no kind parameter" (same
  // for scope); the ticks themselves stay as ticked.
  const kind: RunKindFilter | undefined = kinds.length === 1 ? kinds[0] : undefined;
  const user = canSeeEveryRun && scopes.includes("me") ? "me" : undefined;

  return (
    <RunList
      user={user}
      kind={kind}
      status={statuses}
      spaceIds={spaceIds}
      search={search}
      countLabel={(total) => t("runs.count", { count: total })}
      toolbar={({ columns }) => (
        <ListToolbar
          search={{
            value: search,
            onChange: list.setSearch,
            placeholder: searchPlaceholder,
          }}
          scope={scope}
          filters={filters}
          onReset={list.reset}
          columns={columns}
        />
      )}
      // A filtered list that finds nothing ran out of matches: the way out is the filter.
      emptyState={
        search || filters.some((f) => f.values.length > 0) ? (
          <NoMatchState message={t("runs.emptyFiltered")} onReset={list.reset} />
        ) : undefined
      }
    />
  );
}
