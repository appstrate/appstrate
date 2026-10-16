// SPDX-License-Identifier: Apache-2.0

/**
 * A collection of packages: the bar, the body, the count.
 *
 * Everything the agents, skills and MCP-server pages draw below their title,
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
import { LayoutGrid, Rows3, type LucideIcon } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@appstrate/ui/components/tabs";
import type { PackageType } from "@appstrate/core/validation";
import type { DataColumn } from "./data-table";
import { CardGrid } from "./card-grid";
import { PackageCard } from "./package-card";
import { PackagesTable } from "./packages-table";
import { ListFooter, ListToolbar, type ColumnMenuSpec, type FilterSpec } from "./list-toolbar";
import { EmptyState, NoMatchState } from "./page-states";
import { SettingsHeading } from "./settings/settings-heading";
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
  /**
   * Dimensions the CALLER filters on. It has already narrowed `items`; the bar
   * only draws these, next to the ones this component owns.
   */
  extraFilters?: FilterSpec[];
  /** Whether an agent card offers its run button. A catalogue's cannot. */
  cardRun?: boolean;
  /** Drawn at the right end of the bar, where a list's actions always are. */
  actions?: ReactNode;
  /** Above the bar: what this collection is. */
  header?: ReactNode;
  /** `CollectionTabs` for the bar's line, before the search. */
  tabs?: ReactNode;
  /** Open a row in place rather than on its own page. */
  rowAction?: (item: CardItem) => void;
  /**
   * Cards split into titled sections, in order — how the catalogue's Découvrir
   * says what its ticks mean ("Pas encore dans Default", "Déjà dans Default").
   * An empty section is not drawn. Loading, failure and an empty list keep the
   * single grid, whose states say those things already.
   */
  cardSections?: (items: CardItem[]) => { key: string; title: string; items: CardItem[] }[];
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
  cardRun = true,
  actions,
  header,
  tabs,
  rowAction,
  cardSections,
}: PackageCollectionProps) {
  const { t } = useTranslation(["agents", "common"]);
  // Client-side on purpose, and honestly so: this catalogue arrives whole, so
  // the box searches the whole list rather than the page on screen — which is
  // exactly why the run list, paginated server-side, has no box.
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
    Boolean(query) ||
    origins.length > 0 ||
    activities.length > 0 ||
    extraFilters.some((filter) => filter.values.length > 0);

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
        tabs={tabs}
        search={{ value: query, onChange: list.setSearch, placeholder: searchPlaceholder }}
        filters={filters}
        onReset={list.reset}
        columns={view === "table" ? columnMenu : undefined}
        actions={
          <>
            {onViewChange && (
              <Tabs value={view} onValueChange={(next) => onViewChange(next as ListView)}>
                <TabsList className="h-9">
                  <TabsTrigger value="table" aria-label={t("toolbar.viewTable", { ns: "common" })}>
                    <Rows3 className="size-4" />
                  </TabsTrigger>
                  <TabsTrigger value="cards" aria-label={t("toolbar.viewCards", { ns: "common" })}>
                    <LayoutGrid className="size-4" />
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            )}
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
      ) : cardSections && !isLoading && !error && shown.length > 0 ? (
        <div className="flex flex-col gap-8 pt-2">
          {cardSections(shown)
            .filter((section) => section.items.length > 0)
            .map((section) => (
              <section key={section.key}>
                <SettingsHeading
                  level="group"
                  title={
                    <>
                      {section.title}{" "}
                      <span className="text-muted-foreground font-normal tabular-nums">
                        {section.items.length}
                      </span>
                    </>
                  }
                />
                <CardGrid
                  items={section.items}
                  itemKey={(item) => item.id}
                  renderCard={(item) => (
                    <PackageCard
                      {...item}
                      showRun={cardRun}
                      onOpen={rowAction ? () => rowAction(item) : undefined}
                    />
                  )}
                  isLoading={false}
                  isError={false}
                  empty={null}
                />
              </section>
            ))}
        </div>
      ) : (
        <CardGrid
          items={shown}
          itemKey={(item) => item.id}
          renderCard={(item) => (
            <PackageCard
              {...item}
              showRun={cardRun}
              onOpen={rowAction ? () => rowAction(item) : undefined}
            />
          )}
          isLoading={isLoading}
          failure={error}
          empty={emptyBody}
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
