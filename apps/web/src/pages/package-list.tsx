// SPDX-License-Identifier: Apache-2.0

import { type ReactNode, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import { type LucideIcon, Layers, Plus, SearchX, Upload } from "lucide-react";
import type { PackageType } from "@appstrate/core/validation";
import { Button } from "@appstrate/ui/components/button";
import { DropdownMenuItem } from "@appstrate/ui/components/dropdown-menu";
import { useAgents } from "../hooks/use-packages";
import { useUnreadCountsByAgent } from "../hooks/use-notifications";
import { PackageCard } from "../components/package-card";
import { CardGrid } from "../components/card-grid";
import { PackagesTable, usePackageColumns } from "../components/packages-table";
import { columnMenu, visibleColumns } from "../components/data-table";
import { useColumnVisibility } from "../stores/column-visibility-store";
import { ListFooter, ListToolbar } from "../components/list-toolbar";
import { usePackageViewStore } from "../stores/list-view-store";
import { useSearchPlaceholder } from "../lib/search-placeholder";
import { PageHeader, type BreadcrumbEntry } from "../components/page-header";
import { PageActionsMenu } from "../components/page-actions-menu";
import { ImportModal } from "../components/import-modal";
import { ErrorState, EmptyState } from "../components/page-states";
import { usePermissions } from "../hooks/use-permissions";
import { CreationHandoffModal } from "../components/creation-handoff-modal";
import { useCreationHandoff } from "../hooks/use-creation-handoff";

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
  /** What KIND it holds. Decides which columns can say anything at all. */
  holds: PackageType;
  extraActions?: ReactNode;
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
  holds,
  extraActions,
  headerContent,
}: PackageTabProps) {
  const { t } = useTranslation(["agents", "common"]);
  const view = usePackageViewStore((s) => s.view);
  const setView = usePackageViewStore((s) => s.setView);
  // Client-side on purpose, and honestly so: this catalogue arrives whole, so
  // the box searches the whole list rather than the page on screen — which is
  // exactly why the run list, paginated server-side, has no box.
  const [query, setQuery] = useState("");
  const allColumns = usePackageColumns(holds);
  const searchPlaceholder = useSearchPlaceholder(entity);
  const visibility = useColumnVisibility("packages");

  const header = title ? (
    <PageHeader title={title} emoji={emoji} breadcrumbs={breadcrumbs} actions={extraActions}>
      {headerContent}
    </PageHeader>
  ) : null;

  const shown = (items ?? []).filter((item) => matches(item, query));

  // An empty list, a search that matched nothing, and a request that failed are
  // three different sentences, and the body says whichever applies IN PLACE —
  // the bar and the count above and below it never move. This used to be three
  // early returns above the toolbar, which is how an empty list lost its bar
  // and had to re-offer the page's own actions as unlabelled icons.
  const emptyBody = query ? (
    <EmptyState message={t("list.noMatch")} icon={SearchX} compact>
      <Button variant="outline" size="sm" onClick={() => setQuery("")}>
        {t("toolbar.clearAll", { ns: "common" })}
      </Button>
    </EmptyState>
  ) : (
    // No actions of its own any more: the bar above is always there now, with
    // the same two, written out. The empty state used to carry them because it
    // REPLACED the bar, and it carried them as unlabelled icons — in the one
    // state where the reader least knows what to do.
    <EmptyState message={emptyMessage} hint={emptyHint} icon={emptyIcon} compact />
  );

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
        // Only the table view has columns to choose from.
        columns={view === "table" ? columnMenu(allColumns, visibility) : undefined}
        view={view}
        onViewChange={setView}
        actions={title ? undefined : extraActions}
      />
      {view === "table" ? (
        <PackagesTable
          items={shown}
          columns={visibleColumns(allColumns, visibility.hidden)}
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

export function PackageList() {
  const { t } = useTranslation(["agents", "common"]);
  const { data: agents, isLoading, error } = useAgents();
  const { data: unreadCounts } = useUnreadCountsByAgent();
  const { isAdmin } = usePermissions();
  const [importOpen, setImportOpen] = useState(false);
  const navigate = useNavigate();
  const creation = useCreationHandoff("agent", isAdmin);

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
        holds="agent"
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
            <PageActionsMenu>
              <DropdownMenuItem data-page-action="import" onSelect={() => setImportOpen(true)}>
                <Upload />
                {t("nav.import", { ns: "common" })}
              </DropdownMenuItem>
              <DropdownMenuItem data-page-action="create" onSelect={creation.open}>
                <Plus />
                {t("list.create")}
              </DropdownMenuItem>
            </PageActionsMenu>
          ) : undefined
        }
      />
      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} />
      {creation.isOpen && (
        <CreationHandoffModal
          resource="agent"
          onClose={creation.close}
          onManual={() => navigate("/agents/new")}
          onChat={creation.openChat}
        />
      )}
    </div>
  );
}
