// SPDX-License-Identifier: Apache-2.0

/**
 * The integration index: what this space can use. Like every index it holds the ACTIVE set; one
 * placed here but switched off, or never switched on, is in the space library.
 */

import { useMemo, useState } from "react";
import { catalogueHref } from "../lib/catalogue-link";
import { useTranslation } from "react-i18next";
import { Boxes, LibraryBig, Plus, Upload } from "lucide-react";
import { packagePermission, spacePackagePermission } from "@appstrate/core/permissions";
import { PageHeader } from "../components/page-header";
import { CardGrid } from "../components/card-grid";
import { PackageCard, PackageCardSkeleton } from "../components/package-card";
import { ListViewTabs } from "../components/list-view-tabs";
import { packageCardItem } from "../lib/package-card-item";
import { useListView } from "../stores/list-view-store";
import { DataTable } from "../components/data-table";
import { ListFooter, ListToolbar } from "../components/list-toolbar";
import { EmptyState, EmptyStateAction, NoMatchState } from "../components/page-states";
import { PageActionsMenu } from "../components/page-actions-menu";
import type { MenuAction } from "../lib/menu-action";
import { CreationHandoffModal } from "../components/creation-handoff-modal";
import { ImportModal } from "../components/import-modal";
import { SpaceLibraryHint } from "../components/space-library-hint";
import { CreatePackageModal } from "../components/create-package-modal";
import { useCreationHandoff } from "../hooks/use-creation-handoff";
import {
  INTEGRATION_ORIGINS,
  INTEGRATION_SOURCES,
  filterIntegrations,
} from "../lib/integration-collection";
import { useListParams } from "../lib/list-params";
import { useSearchPlaceholder } from "../lib/search-placeholder";
import { useConnectionCounts } from "../hooks/use-me-connections";
import { usePackageList } from "../hooks/use-packages";
import { usePermissions } from "../hooks/use-permissions";
import { useOrg } from "../hooks/use-org";
import { useColumnVisibility } from "../stores/column-visibility-store";
import { IntegrationSourceLabel } from "../components/integration-source-label";
import { useIntegrationListColumns } from "./integration-list-columns";

export function IntegrationsPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { can } = usePermissions();
  const orgName = useOrg().currentOrg?.name ?? "";
  // The server answers the active set of this space: the index route every
  // type page asks, not the management listing.
  const { data: active = [], isLoading, error } = usePackageList("integration");
  const connectionCounts = useConnectionCounts();
  const [view, setView] = useListView("integrations");
  const list = useListParams(["origin", "source"]);
  const searchPlaceholder = useSearchPlaceholder(t("integrations.title"));
  const [importing, setImporting] = useState(false);
  // The same grants as every other package index (`PackageIndexPage`): creating,
  // by import too, is a write on the type.
  const canCreate = can(packagePermission("integration", "write"));
  const canBrowse = can(spacePackagePermission("integration", "activate"));
  const creation = useCreationHandoff("integration", canCreate);
  const [creating, setCreating] = useState(false);
  const createAction: MenuAction = {
    id: "create",
    label: t("integrations.create"),
    icon: Plus,
    onSelect: creation.open,
    hidden: !canCreate,
  };

  const origins = list.values("origin", INTEGRATION_ORIGINS);
  const sources = list.values("source", INTEGRATION_SOURCES);
  const query = list.search;

  const shown = useMemo(
    () => filterIntegrations(active, { query, origins, sources }),
    [active, query, origins, sources],
  );
  const filtering = query.trim() !== "" || origins.length > 0 || sources.length > 0;

  const allColumns = useIntegrationListColumns(connectionCounts);
  const { columns, menu } = useColumnVisibility("integrations", allColumns);
  const empty = filtering ? (
    <NoMatchState message={t("integrations.empty.filtered")} onReset={list.reset} />
  ) : (
    <EmptyState
      icon={Boxes}
      compact
      message={t("integrations.empty.space")}
      hint={<SpaceLibraryHint type="integration" />}
    >
      <EmptyStateAction action={createAction} />
    </EmptyState>
  );

  return (
    <div>
      <PageHeader
        title={t("integrations.title")}
        variant="collection"
        breadcrumbs={[{ label: t("integrations.title") }]}
        wrapActions
        actions={
          <PageActionsMenu
            actions={[
              {
                id: "catalogue",
                label: t("catalogue.browse"),
                icon: LibraryBig,
                to: catalogueHref("integration"),
                hidden: !canBrowse,
              },
              {
                id: "import",
                label: t("nav.import", { ns: "common" }),
                icon: Upload,
                onSelect: () => setImporting(true),
                hidden: !canCreate,
              },
              createAction,
            ]}
          />
        }
      />

      <ListToolbar
        search={{ value: query, onChange: list.setSearch, placeholder: searchPlaceholder }}
        filters={[
          {
            id: "origin",
            label: t("integrations.filter.origin"),
            values: origins,
            onChange: list.setValues("origin"),
            options: [
              { value: "custom", label: t("catalogue.sourceOrg", { name: orgName }) },
              { value: "system", label: t("catalogue.sourceSystem") },
            ],
          },
          {
            id: "source",
            label: t("integrations.filter.source"),
            values: sources,
            onChange: list.setValues("source"),
            options: INTEGRATION_SOURCES.map((source) => ({
              value: source,
              label: t(`integrations.source.${source}`),
            })),
          },
        ]}
        onReset={list.reset}
        columns={view === "table" ? menu : undefined}
        actions={<ListViewTabs view={view} onChange={setView} />}
      />

      {view === "table" ? (
        <DataTable
          tableId="integrations"
          label={t("integrations.tableLabel")}
          columns={columns}
          rows={shown}
          rowKey={(integration) => integration.id}
          rowHref={(integration) => `/integrations/${integration.id}`}
          rowLabel={(integration) => integration.name}
          isLoading={isLoading}
          failure={error}
          empty={empty}
        />
      ) : (
        <CardGrid
          items={shown}
          itemKey={(integration) => integration.id}
          renderCard={(integration) => (
            <PackageCard
              {...packageCardItem(integration, "integration")}
              meta={
                <>
                  <IntegrationSourceLabel source={integration.source_kind} />
                  {connectionCounts && (
                    <>
                      <span aria-hidden>·</span>
                      <span className="shrink-0">
                        {t("connections.connectionCount", {
                          count: connectionCounts.get(integration.id) ?? 0,
                        })}
                      </span>
                    </>
                  )}
                </>
              }
            />
          )}
          isLoading={isLoading}
          failure={error}
          empty={empty}
          placeholder={<PackageCardSkeleton meta="both" />}
        />
      )}
      <ListFooter
        count={isLoading || error ? undefined : t("integrations.count", { count: shown.length })}
      />

      {importing && canCreate && (
        <ImportModal type="integration" onClose={() => setImporting(false)} />
      )}
      {creation.isOpen && (
        <CreationHandoffModal
          resource="integration"
          onClose={creation.close}
          onFromUrl={() => creation.leave("/integrations/new/mcp")}
          onManual={() => {
            creation.close();
            setCreating(true);
          }}
          onImport={() => {
            creation.close();
            setImporting(true);
          }}
          onChat={creation.openChat}
        />
      )}
      {creating && canCreate && (
        <CreatePackageModal type="integration" onClose={() => setCreating(false)} />
      )}
    </div>
  );
}
