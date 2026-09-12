// SPDX-License-Identifier: Apache-2.0

import { type ReactNode, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import { Layers, LibraryBig, Plus, type LucideIcon, Upload } from "lucide-react";
import type { PackageType } from "@appstrate/core/validation";
import { DropdownMenuItem } from "@appstrate/ui/components/dropdown-menu";
import { useAgents } from "../hooks/use-packages";
import { useUnreadCountsByAgent } from "../hooks/use-notifications";
import { usePackageViewStore } from "../stores/list-view-store";
import { useListParams } from "../lib/list-params";
import { PageHeader, type BreadcrumbEntry } from "../components/page-header";
import { PackageCollection } from "../components/package-collection";
import { PageActionsMenu } from "../components/page-actions-menu";
import { ImportModal } from "../components/import-modal";
import { usePermissions } from "../hooks/use-permissions";
import { OrgCatalogueModal } from "../components/org-catalogue-modal";
import { useModalParam } from "../hooks/use-modal-param";
import { PACKAGE_PERMISSIONS } from "../lib/package-permissions";
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

export function PackageTab({
  title,
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
  const view = usePackageViewStore((s) => s.view);
  const setView = usePackageViewStore((s) => s.setView);
  const list = useListParams(["origin", "activity"]);

  return (
    <>
      {title ? (
        <PageHeader
          title={title}
          variant="collection"
          breadcrumbs={breadcrumbs}
          actions={extraActions}
        >
          {headerContent}
        </PageHeader>
      ) : null}
      <PackageCollection
        items={items}
        isLoading={isLoading}
        error={error}
        holds={holds}
        entity={entity}
        emptyMessage={emptyMessage}
        emptyHint={emptyHint}
        emptyIcon={emptyIcon}
        list={list}
        view={view}
        onViewChange={setView}
        // A titled page already carries them in its header; a tab has no header
        // of its own, so the bar is where they go.
        actions={title ? undefined : extraActions}
      />
    </>
  );
}

export function PackageList() {
  const { t } = useTranslation(["agents", "common"]);
  const { data: agents, isLoading, error } = useAgents();
  const { data: unreadCounts } = useUnreadCountsByAgent();
  const { can } = usePermissions();
  const [importOpen, setImportOpen] = useState(false);
  const navigate = useNavigate();
  const creation = useCreationHandoff("agent", can("agents:write"));
  const canActivate = can(PACKAGE_PERMISSIONS.agent.install);
  const catalogue = useModalParam("catalogue");

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
        breadcrumbs={[{ label: t("list.tabAgents") }]}
        items={items}
        isLoading={isLoading}
        error={error}
        emptyMessage={t("list.empty")}
        emptyHint={<Trans t={t} i18nKey="list.emptyHint" components={{ 1: <code /> }} />}
        emptyIcon={Layers}
        extraActions={
          can("agents:write") || canActivate ? (
            <PageActionsMenu>
              {canActivate && (
                <DropdownMenuItem
                  data-page-action="catalogue"
                  onSelect={() => catalogue.open("agent")}
                >
                  <LibraryBig />
                  {t("catalogue.browse", { ns: "settings" })}
                </DropdownMenuItem>
              )}
              {can("agents:write") && (
                <>
                  <DropdownMenuItem data-page-action="import" onSelect={() => setImportOpen(true)}>
                    <Upload />
                    {t("nav.import", { ns: "common" })}
                  </DropdownMenuItem>
                  <DropdownMenuItem data-page-action="create" onSelect={creation.open}>
                    <Plus />
                    {t("list.create")}
                  </DropdownMenuItem>
                </>
              )}
            </PageActionsMenu>
          ) : undefined
        }
      />
      {catalogue.value !== null && canActivate && (
        <OrgCatalogueModal
          type={catalogue.value}
          onTypeChange={catalogue.open}
          onClose={catalogue.close}
        />
      )}
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
