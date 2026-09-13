// SPDX-License-Identifier: Apache-2.0

/**
 * A collection of packages: the bar, the body, the count.
 *
 * Everything the agents, skills and MCP-server pages draw below their title,
 * and everything the organisation's catalogue draws inside its panel. They are
 * the SAME list of the same objects, so they are one component: the same
 * search, the same faceted filters, the same column set, the same view toggle,
 * the same empty states. The catalogue adds a tick per row and one action in
 * the bar; it does not get a table of its own.
 *
 * What the caller decides is where the state lives (the URL on a page, the
 * component in a panel, see `ListState`) and what, if anything, hangs off each
 * row.
 */
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { SearchX, type LucideIcon } from "lucide-react";
import type { PackageType } from "@appstrate/core/validation";
import { Button } from "@appstrate/ui/components/button";
import type { ListView } from "@/stores/list-view-store";
import { columnMenu, visibleColumns, type DataColumn } from "./data-table";
import { CardGrid } from "./card-grid";
import { PackageCard } from "./package-card";
import { PackagesTable, usePackageColumns } from "./packages-table";
import { ListFooter, ListToolbar, type FilterSpec } from "./list-toolbar";
import { EmptyState, ErrorState } from "./page-states";
import { useColumnVisibility } from "../stores/column-visibility-store";
import { useSearchPlaceholder } from "../lib/search-placeholder";
import type { ListState } from "../lib/list-params";
import type { CardItem } from "../pages/package-list";

/** Stable empties: a fresh literal in a default would remount the table set. */
const NO_COLUMNS: DataColumn<CardItem>[] = [];
const NO_IDS: string[] = [];

/** Name, description and keywords — everything a card puts on screen. */
function matches(item: CardItem, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    item.displayName.toLowerCase().includes(q) ||
    (item.description?.toLowerCase().includes(q) ?? false) ||
    (item.keywords?.some((keyword) => keyword.toLowerCase().includes(q)) ?? false)
  );
}

export interface PackageCollectionProps {
  items: CardItem[] | undefined;
  isLoading: boolean;
  error?: Error | null;
  /** What the list holds. Decides which columns can say anything at all. */
  holds: PackageType;
  /** What it holds, plural, for the search box: "Agents", "Compétences". */
  entity: string;
  emptyMessage: string;
  emptyHint?: ReactNode;
  emptyIcon: LucideIcon;
  list: ListState;
  view: ListView;
  onViewChange: (view: ListView) => void;
  placement?: "page" | "panel";
  /**
   * Whether the list can say what is running or what uses this package. The
   * catalogue reads the library, which knows neither, so it offers origin only
   * rather than a filter that would silently empty the table.
   */
  activityFilter?: boolean;
  /**
   * Whether the bar offers the origin dimension. The catalogue turns it off
   * where it draws the same distinction as tabs, so it is never asked twice.
   */
  originFilter?: boolean;
  /** Drawn at the right end of the bar, where a list's actions always are. */
  actions?: ReactNode;
  /** Above the bar: what this collection is, and any tabs that narrow it. */
  header?: ReactNode;
  /** Open a row in place rather than on its own page. */
  rowAction?: (item: CardItem) => void;
  /** Ahead of the name: the catalogue's tick. */
  leadingColumns?: DataColumn<CardItem>[];
  /** After the rest: the catalogue's per-row deed. */
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
  entity,
  emptyMessage,
  emptyHint,
  emptyIcon,
  list,
  view,
  onViewChange,
  placement = "page",
  activityFilter = true,
  originFilter = true,
  actions,
  header,
  rowAction,
  leadingColumns = NO_COLUMNS,
  trailingColumns = NO_COLUMNS,
  dropColumns = NO_IDS,
}: PackageCollectionProps) {
  const { t } = useTranslation(["agents", "common"]);
  // Client-side on purpose, and honestly so: this catalogue arrives whole, so
  // the box searches the whole list rather than the page on screen — which is
  // exactly why the run list, paginated server-side, has no box.
  const query = list.search;
  const origins = list.values("origin", ["local", "system"] as const);
  const activities = list.values("activity", ["active", "inactive"] as const);
  const baseColumns = usePackageColumns(holds).filter((c) => !dropColumns.includes(c.id));
  const searchPlaceholder = useSearchPlaceholder(entity);
  const visibility = useColumnVisibility("packages");

  const shown = (items ?? []).filter((item) => {
    if (!matches(item, query)) return false;
    if (origins.length > 0 && !origins.includes(item.source ?? "local")) return false;
    if (!activityFilter) return true;

    const isActive = holds === "agent" ? Boolean(item.runningRuns) : Boolean(item.usedByAgents);
    if (activities.includes("active") && !activities.includes("inactive") && !isActive)
      return false;
    if (activities.includes("inactive") && !activities.includes("active") && isActive) return false;
    return true;
  });

  const filters: FilterSpec[] = [
    ...(originFilter
      ? [
          {
            id: "origin",
            label: t("list.filter.origin"),
            values: origins,
            options: [
              { value: "local", label: t("list.filter.local") },
              { value: "system", label: t("list.filter.system") },
            ],
            onChange: list.setValues("origin"),
          },
        ]
      : []),
    ...(activityFilter
      ? [
          {
            id: "activity",
            label: t(holds === "agent" ? "list.filter.execution" : "list.filter.usage"),
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
  // the bar and the count above and below it never move. This used to be three
  // early returns above the toolbar, which is how an empty list lost its bar
  // and had to re-offer the page's own actions as unlabelled icons.
  const emptyBody = filtering ? (
    <EmptyState message={t("list.noMatch")} icon={SearchX} compact>
      <Button variant="outline" size="sm" onClick={list.reset}>
        {t("toolbar.clearAll", { ns: "common" })}
      </Button>
    </EmptyState>
  ) : (
    <EmptyState message={emptyMessage} hint={emptyHint} icon={emptyIcon} compact />
  );

  return (
    <>
      {header}
      <ListToolbar
        placement={placement}
        search={{ value: query, onChange: list.setSearch, placeholder: searchPlaceholder }}
        filters={filters}
        onReset={list.reset}
        // Only the table view has columns to choose from, and only the set the
        // list owns: a tick and a deed are not columns anyone hides.
        columns={view === "table" ? columnMenu(baseColumns, visibility) : undefined}
        view={view}
        onViewChange={onViewChange}
        actions={actions}
      />
      {view === "table" ? (
        <PackagesTable
          items={shown}
          rowAction={rowAction}
          columns={[
            ...leadingColumns,
            ...visibleColumns(baseColumns, visibility.hidden),
            ...trailingColumns,
          ]}
          isLoading={isLoading}
          isError={Boolean(error)}
          empty={emptyBody}
          error={<ErrorState message={error?.message} compact />}
        />
      ) : (
        <CardGrid
          items={shown}
          itemKey={(item) => item.id}
          renderCard={(item) => <PackageCard {...item} />}
          isLoading={isLoading}
          isError={Boolean(error)}
          empty={emptyBody}
          error={<ErrorState message={error?.message} compact />}
        />
      )}
      {/* Under the body, like the runs page: what the collection amounts to,
          whatever it happens to hold and whether or not anyone searched. */}
      <ListFooter
        count={isLoading || error ? undefined : t("list.count", { count: shown.length })}
      />
    </>
  );
}
