// SPDX-License-Identifier: Apache-2.0

import { type ReactNode, useState } from "react";
import { Link } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import { type LucideIcon, Layers, SearchX } from "lucide-react";
import type { PackageType } from "@appstrate/core/validation";
import { Button } from "@appstrate/ui/components/button";
import { useAgents } from "../hooks/use-packages";
import { useUnreadCountsByAgent } from "../hooks/use-notifications";
import { PackageCard } from "../components/package-card";
import { PackagesTable, usePackageColumns } from "../components/packages-table";
import { columnMenu, visibleColumns } from "../components/data-table";
import { useColumnVisibility } from "../stores/column-visibility-store";
import { ListToolbar } from "../components/list-toolbar";
import { usePackageViewStore } from "../stores/list-view-store";
import { useSearchPlaceholder } from "../lib/search-placeholder";
import { PageHeader, type BreadcrumbEntry } from "../components/page-header";
import { ImportModal } from "../components/import-modal";
import { LoadingState, ErrorState, EmptyState } from "../components/page-states";
import { usePermissions } from "../hooks/use-permissions";

export interface CardItem {
  id: string;
  displayName: string;
  description?: string | null;
  type: PackageType;
  source?: "system" | "local";
  runningRuns?: number;
  keywords?: string[];
  usedByAgents?: number;
  unreadCount?: number;
  actions?: ReactNode;
  autoInstalled?: boolean;
}

interface PackageTabProps {
  title?: string;
  emoji?: string;
  breadcrumbs?: BreadcrumbEntry[];
  items: CardItem[] | undefined;
  isLoading: boolean;
  error?: Error | null;
  emptyMessage: string;
  emptyHint: ReactNode;
  emptyIcon: LucideIcon;
  /** What the list holds, plural, for the search box: "Agents", "Skills". */
  entity: string;
  extraActions?: ReactNode;
  emptyExtraActions?: ReactNode;
  headerContent?: ReactNode;
}

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

export function PackageTab({
  title,
  emoji,
  breadcrumbs,
  items,
  isLoading,
  error,
  emptyMessage,
  emptyHint,
  emptyIcon,
  entity,
  extraActions,
  emptyExtraActions,
  headerContent,
}: PackageTabProps) {
  const { t } = useTranslation(["agents", "common"]);
  const view = usePackageViewStore((s) => s.view);
  const setView = usePackageViewStore((s) => s.setView);
  // Client-side on purpose, and honestly so: this catalogue arrives whole, so
  // the box searches the whole list rather than the page on screen — which is
  // exactly why the run list, paginated server-side, has no box.
  const [query, setQuery] = useState("");
  const allColumns = usePackageColumns();
  const searchPlaceholder = useSearchPlaceholder(entity);
  const visibility = useColumnVisibility("packages");

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  const header = title ? (
    <PageHeader title={title} emoji={emoji} breadcrumbs={breadcrumbs}>
      {headerContent}
    </PageHeader>
  ) : null;

  const emptyActions = emptyExtraActions !== undefined ? emptyExtraActions : extraActions;

  if (!items || items.length === 0) {
    return (
      <>
        {header}
        <EmptyState message={emptyMessage} hint={emptyHint} icon={emptyIcon}>
          {emptyActions}
        </EmptyState>
      </>
    );
  }

  const shown = items.filter((item) => matches(item, query));

  return (
    <>
      {header}
      <ListToolbar
        search={{
          value: query,
          onChange: setQuery,
          placeholder: searchPlaceholder,
        }}
        filters={[]}
        count={query ? t("list.count", { count: shown.length }) : undefined}
        // Only the table view has columns to choose from.
        columns={view === "table" ? columnMenu(allColumns, visibility) : undefined}
        view={view}
        onViewChange={setView}
        actions={extraActions}
      />
      {shown.length === 0 ? (
        // Nothing MATCHED, which is not the same sentence as nothing exists.
        <EmptyState message={t("list.noMatch")} icon={SearchX} compact>
          <Button variant="outline" size="sm" onClick={() => setQuery("")}>
            {t("toolbar.clearAll", { ns: "common" })}
          </Button>
        </EmptyState>
      ) : view === "table" ? (
        <PackagesTable items={shown} columns={visibleColumns(allColumns, visibility.hidden)} />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {shown.map((item) => (
            <PackageCard key={item.id} {...item} />
          ))}
        </div>
      )}
    </>
  );
}

export function PackageList() {
  const { t } = useTranslation(["agents", "common"]);
  const { data: agents, isLoading, error } = useAgents();
  const { data: unreadCounts } = useUnreadCountsByAgent();
  const { isAdmin } = usePermissions();
  const [importOpen, setImportOpen] = useState(false);

  const items: CardItem[] | undefined = agents?.map((f) => ({
    id: f.id,
    displayName: f.display_name ?? f.id,
    description: f.description ?? null,
    type: "agent",
    source: f.source,
    runningRuns: f.running_runs,
    keywords: f.keywords,
    unreadCount: unreadCounts?.[f.id],
  }));

  return (
    <div>
      <PackageTab
        title={t("list.tabAgents")}
        entity={t("list.tabAgents")}
        emoji="⚡"
        breadcrumbs={[{ label: t("list.tabAgents") }]}
        items={items}
        isLoading={isLoading}
        error={error}
        emptyMessage={t("list.empty")}
        emptyHint={<Trans t={t} i18nKey="list.emptyHint" components={{ 1: <code /> }} />}
        emptyIcon={Layers}
        extraActions={
          isAdmin ? (
            <>
              <Button
                variant="outline"
                size="sm"
                className="h-8"
                onClick={() => setImportOpen(true)}
              >
                {t("nav.import", { ns: "common" })}
              </Button>
              <Link to="/agents/new">
                <Button size="sm" className="h-8">
                  {t("list.create")}
                </Button>
              </Link>
            </>
          ) : undefined
        }
      />
      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} />
    </div>
  );
}
