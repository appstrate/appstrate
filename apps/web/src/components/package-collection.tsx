// SPDX-License-Identifier: Apache-2.0

/**
 * A collection of packages: the bar, the body, the count.
 *
 * Everything the agents, skills and integrations pages draw below their title,
 * and everything the organization's catalogue draws inside its panel. They are
 * the same objects with shared search, filters and empty states. Each caller
 * composes the columns and their visibility menu.
 *
 * What the caller decides is where the state lives (the URL on a page, the
 * component in a panel, see `ListState`) and what, if anything, hangs off each
 * row.
 */
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { LucideIcon } from "lucide-react";
import { ListViewTabs } from "./list-view-tabs";
import type { PackageType } from "@appstrate/core/validation";
import type { DataColumn } from "./data-table";
import { CardGrid } from "./card-grid";
import { PackageCard, PackageCardSkeleton } from "./package-card";
import { PackagesTable } from "./packages-table";
import { ListFooter, ListToolbar, type ColumnMenuSpec, type FilterSpec } from "./list-toolbar";
import { readerFiltered } from "../lib/reader-filtered";
import { showsTeamEmpty } from "../lib/space-filter";
import { EmptyState, NoMatchState, SpaceFilterEmpty } from "./page-states";
import { useSearchPlaceholder } from "../lib/search-placeholder";
import type { ListState } from "../lib/list-params";
import type { ListView } from "../stores/list-view-store";
import { PACKAGE_ACTIVITIES, PACKAGE_ORIGINS, narrowPackages } from "../lib/package-collection";
import type { CardItem } from "../lib/package-card-item";

const NO_FILTERS: FilterSpec[] = [];

export interface OriginLabels {
  title: string;
  local: string;
  system: string;
}

export interface PackageCollectionProps {
  columns: DataColumn<CardItem>[];
  columnMenu: ColumnMenuSpec;
  items: CardItem[] | undefined;
  isLoading: boolean;
  error?: Error | null;
  /** What the list holds, for search and activity filters. */
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
  /** How this surface draws the list: the index pages let the reader choose, the catalogue's management view is a table. */
  view: ListView;
  /** Offers the choice between the two drawings; without it the list keeps `view`. */
  onViewChange?: (view: ListView) => void;
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
  /** Dimensions the CALLER filters on. It has already narrowed `items`; the bar only draws these, next to the ones this component owns. */
  extraFilters?: FilterSpec[];
  /**
   * Given while the space filter narrows `items`: how many rows it hides, so an empty list that
   * hides some offers to widen (`showsTeamEmpty`) instead of the page's own empty state.
   */
  spaceNarrowing?: { hiddenCount: number; message: string; showAll: () => void };
  /** Whether an agent card offers its run button. A catalogue's cannot. */
  cardRun?: boolean;
  /** The list spans several spaces: each card names its row's spaces. */
  spanning?: boolean;
  /** Drawn at the right end of the bar, where a list's actions always are. */
  actions?: ReactNode;
  /** Above the bar: what this collection is. */
  header?: ReactNode;
  /** Open a row in place rather than on its own page. */
  rowAction?: (item: CardItem) => void;
  /** A card while the collection loads; the index pages' card when unset. */
  cardPlaceholder?: ReactNode;
}

export function PackageCollection({
  columns,
  columnMenu,
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
  view,
  onViewChange,
  activityFilter = true,
  originLabels,
  extraFilters = NO_FILTERS,
  spaceNarrowing,
  cardRun = true,
  spanning = false,
  actions,
  header,
  rowAction,
  cardPlaceholder,
}: PackageCollectionProps) {
  const { t } = useTranslation(["agents", "common"]);
  // Client-side on purpose, and honestly so: this catalogue arrives whole, so
  // the box searches the whole list rather than the page on screen. A list
  // paged server-side (runs, files) searches through its `q` parameter instead.
  const query = list.search;
  const origins = list.values("origin", PACKAGE_ORIGINS);
  const activities = activityFilter ? list.values("activity", PACKAGE_ACTIVITIES) : [];
  const searchPlaceholder = useSearchPlaceholder(entity);

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
    ...extraFilters,
  ];
  const filtering =
    Boolean(query) || origins.length > 0 || activities.length > 0 || readerFiltered(extraFilters);

  // An empty list, a search that matched nothing, and a request that failed are
  // three different sentences, and the body says whichever applies IN PLACE —
  // the bar and the count above and below it never move. An early return above
  // the toolbar would cost an empty list its bar and make it re-offer the
  // page's own actions as unlabelled icons.
  const emptyBody =
    spaceNarrowing &&
    showsTeamEmpty({
      readerFiltered: filtering,
      narrowing: true,
      hiddenCount: spaceNarrowing.hiddenCount,
    }) ? (
      <SpaceFilterEmpty message={spaceNarrowing.message} showAll={spaceNarrowing.showAll} />
    ) : filtering ? (
      <NoMatchState message={t("list.noMatch")} onReset={list.reset} />
    ) : (
      <EmptyState message={emptyMessage} hint={emptyHint} icon={emptyIcon} compact>
        {emptyAction}
      </EmptyState>
    );

  const placeholder = cardPlaceholder ?? (
    <PackageCardSkeleton
      runnable={cardRun && holds === "agent"}
      integrations={holds === "agent"}
      spaceName={spanning}
    />
  );

  return (
    <>
      {header}
      <ListToolbar
        search={{ value: query, onChange: list.setSearch, placeholder: searchPlaceholder }}
        filters={filters}
        onReset={list.reset}
        columns={view === "table" ? columnMenu : undefined}
        actions={
          <>
            {onViewChange && <ListViewTabs view={view} onChange={onViewChange} />}
            {actions}
          </>
        }
      />
      {view === "table" ? (
        <PackagesTable
          tableId={tableId}
          label={entity}
          items={shown}
          rowAction={rowAction}
          columns={columns}
          isLoading={isLoading}
          failure={error}
          empty={emptyBody}
        />
      ) : (
        <CardGrid
          items={shown}
          itemKey={(item) => item.id}
          renderCard={(item) => (
            <PackageCard
              {...item}
              showSpace={spanning}
              showRun={cardRun}
              onOpen={rowAction ? () => rowAction(item) : undefined}
            />
          )}
          isLoading={isLoading}
          failure={error}
          empty={emptyBody}
          placeholder={placeholder}
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
