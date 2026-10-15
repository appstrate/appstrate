// SPDX-License-Identifier: Apache-2.0

/**
 * A collection of packages: the bar, the body, the count.
 *
 * Everything the agents, skills and MCP-server pages draw below their title,
 * and everything the organization's catalogue draws inside its panel. They are
 * the SAME list of the same objects, so they are one component: the same
 * search, the same faceted filters, the same column set, the same empty states.
 * The catalogue adds its origin and switch columns; it does not get a table of its own.
 *
 * What the caller decides is where the state lives (the URL on a page, the
 * component in a panel, see `ListState`) and what, if anything, hangs off each
 * row.
 */
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { LucideIcon } from "lucide-react";
import type { PackageType } from "@appstrate/core/validation";
import type { DataColumn } from "./data-table";
import { PackagesTable } from "./packages-table";
import { usePackageColumns } from "./package-columns";
import { ListFooter, ListToolbar, type FilterSpec } from "./list-toolbar";
import { EmptyState, NoMatchState } from "./page-states";
import { useColumnVisibility } from "../stores/column-visibility-store";
import { useSearchPlaceholder } from "../lib/search-placeholder";
import type { ListState } from "../lib/list-params";
import { PACKAGE_ACTIVITIES, PACKAGE_ORIGINS, narrowPackages } from "../lib/package-collection";
import type { CardItem } from "../lib/package-card-item";

const NO_COLUMNS: DataColumn<CardItem>[] = [];
const NO_IDS: string[] = [];

export interface OriginLabels {
  title: string;
  local: string;
  system: string;
}

export interface PackageCollectionProps {
  items: CardItem[] | undefined;
  isLoading: boolean;
  error?: Error | null;
  /** What the list holds. Decides which columns can say anything at all. */
  holds: PackageType;
  /**
   * Which list this is, for the columns its reader hides and the widths they
   * give: one per screen, so hiding a column on Agents leaves Skills alone.
   */
  tableId: string;
  /** What it holds, plural, for the search box: "Agents", "Compétences". */
  entity: string;
  emptyMessage: string;
  emptyHint?: ReactNode;
  emptyIcon: LucideIcon;
  /** The page's creation button, when the caller may create: the empty list offers it. */
  emptyAction?: ReactNode;
  list: ListState;
  /**
   * Whether the list can say what is running or what uses this package. The
   * catalogue reads the library, which knows neither, so it offers origin only
   * rather than a filter that would silently empty the table.
   */
  activityFilter?: boolean;
  /**
   * How this surface names the origin dimension and its two values. The
   * catalogue says the organization's name where a page says "Personnalisé".
   */
  originLabels?: OriginLabels;
  /** Above the bar: what this collection is. */
  header?: ReactNode;
  /** Open a row in place rather than on its own page. */
  rowAction?: (item: CardItem) => void;
  /** After the rest: the catalogue's origin and per-space switches. */
  trailingColumns?: DataColumn<CardItem>[];
  /**
   * Columns this list cannot answer. The catalogue drops the run state and the
   * run button: an agent that is not active here cannot be running, and cannot
   * be run.
   */
  dropColumns?: string[];
}

export function PackageCollection({
  items,
  isLoading,
  error,
  holds,
  tableId,
  entity,
  emptyMessage,
  emptyHint,
  emptyIcon,
  emptyAction,
  list,
  activityFilter = true,
  originLabels,
  header,
  rowAction,
  trailingColumns = NO_COLUMNS,
  dropColumns = NO_IDS,
}: PackageCollectionProps) {
  const { t } = useTranslation(["agents", "common"]);
  // Client-side on purpose, and honestly so: this catalogue arrives whole, so
  // the box searches the whole list rather than the page on screen — which is
  // exactly why the run list, paginated server-side, has no box.
  const query = list.search;
  const origins = list.values("origin", PACKAGE_ORIGINS);
  const activities = activityFilter ? list.values("activity", PACKAGE_ACTIVITIES) : [];
  const baseColumns = usePackageColumns(holds).filter((c) => !dropColumns.includes(c.id));
  const searchPlaceholder = useSearchPlaceholder(entity);
  const { columns: shownColumns, menu } = useColumnVisibility(tableId, baseColumns);

  const shown = narrowPackages(items ?? [], {
    query,
    origins,
    activities: activityFilter ? activities : undefined,
    holds,
  });

  const filters: FilterSpec[] = [
    {
      id: "origin",
      label: originLabels?.title ?? t("list.filter.origin"),
      values: origins,
      options: [
        { value: "local", label: originLabels?.local ?? t("list.filter.local") },
        { value: "system", label: originLabels?.system ?? t("list.badgeBuiltIn") },
      ],
      onChange: list.setValues("origin"),
    },
    ...(activityFilter
      ? [
          {
            id: "activity",
            label: t(holds === "agent" ? "run.infoExecution" : "run.infoUsage"),
            values: activities,
            options:
              holds === "agent"
                ? [
                    { value: "active", label: t("list.filter.running") },
                    { value: "inactive", label: t("list.filter.idle") },
                  ]
                : [
                    { value: "active", label: t("list.filter.used") },
                    { value: "inactive", label: t("list.filter.unused") },
                  ],
            onChange: list.setValues("activity"),
          },
        ]
      : []),
  ];
  const filtering = Boolean(query) || origins.length > 0 || activities.length > 0;

  // An empty list, a search that matched nothing, and a request that failed are
  // three different sentences, and the body says whichever applies IN PLACE —
  // the bar and the count above and below it never move. An early return above
  // the toolbar would cost an empty list its bar and make it re-offer the
  // page's own actions as unlabelled icons.
  const emptyBody = filtering ? (
    <NoMatchState message={t("list.noMatch")} onReset={list.reset} />
  ) : (
    <EmptyState message={emptyMessage} hint={emptyHint} icon={emptyIcon} compact>
      {emptyAction}
    </EmptyState>
  );

  return (
    <>
      {header}
      <ListToolbar
        search={{ value: query, onChange: list.setSearch, placeholder: searchPlaceholder }}
        filters={filters}
        onReset={list.reset}
        // Only the set the list owns: the catalogue's switches are not columns anyone hides.
        columns={menu}
      />
      <PackagesTable
        label={entity}
        items={shown}
        rowAction={rowAction}
        columns={[...shownColumns, ...trailingColumns]}
        isLoading={isLoading}
        failure={error}
        empty={emptyBody}
      />
      {/* Under the body, like the runs page: what the collection amounts to,
          whatever it happens to hold and whether or not anyone searched. */}
      <ListFooter
        count={isLoading || error ? undefined : t("list.count", { count: shown.length })}
      />
    </>
  );
}
