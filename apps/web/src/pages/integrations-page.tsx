// SPDX-License-Identifier: Apache-2.0

/**
 * The integration index: what this space can use. Like every index it holds the ACTIVE set; one
 * placed here but switched off, or never switched on, is in the space library. In « Vue
 * d'ensemble » it lists every space the reader reaches, each integration once naming its spaces;
 * creating, importing and browsing the catalogue ask which space (`useSpaceAction`).
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Boxes } from "lucide-react";
import { PageHeader } from "../components/page-header";
import { CardGrid } from "../components/card-grid";
import { PackageCard, PackageCardSkeleton } from "../components/package-card";
import { ListViewTabs } from "../components/list-view-tabs";
import { packageCardItem } from "../lib/package-card-item";
import { packageDetailPath } from "../lib/package-paths";
import { useListView } from "../stores/list-view-store";
import { DataTable } from "../components/data-table";
import { ListFooter, ListToolbar } from "../components/list-toolbar";
import { EmptyState, EmptyStateAction, NoMatchState } from "../components/page-states";
import { CreationHandoffModal } from "../components/creation-handoff-modal";
import { ImportModal } from "../components/import-modal";
import { SpaceLibraryHint } from "../components/space-library-hint";
import { CreatePackageModal } from "../components/create-package-modal";
import {
  INTEGRATION_ORIGINS,
  INTEGRATION_SOURCES,
  filterIntegrations,
} from "../lib/integration-collection";
import { useListParams } from "../lib/list-params";
import { useSearchPlaceholder } from "../lib/search-placeholder";
import { useConnectionCounts } from "../hooks/use-me-connections";
import { usePackageList } from "../hooks/use-packages";
import { useOrg } from "../hooks/use-org";
import { useColumnVisibility } from "../stores/column-visibility-store";
import { useOverviewMode } from "../hooks/use-overview-mode";
import { usePackageIndexActions } from "../hooks/use-package-index-actions";
import { useSpaceLink } from "../hooks/use-current-space";
import { IntegrationSourceLabel } from "../components/integration-source-label";
import { useIntegrationListColumns } from "./integration-list-columns";

export function IntegrationsPage() {
  const { t } = useTranslation(["settings", "common"]);
  const orgName = useOrg().currentOrg?.name ?? "";
  const { on: spanning } = useOverviewMode();
  // The server answers the active set of this space (or of each, spanning): the
  // index route every type page asks, not the management listing.
  const { data: active = [], isLoading, error } = usePackageList("integration", spanning);
  const connectionCount = useConnectionCounts();
  const linkInSpace = useSpaceLink();
  const [view, setView] = useListView("integrations");
  const list = useListParams(["origin", "source"]);
  const searchPlaceholder = useSearchPlaceholder(t("integrations.title"));
  const { canCreate, creation, importing, setImporting, createAction, actionsMenu, pickers } =
    usePackageIndexActions("integration", t("integrations.create"));
  const [creating, setCreating] = useState(false);

  const origins = list.values("origin", INTEGRATION_ORIGINS);
  const sources = list.values("source", INTEGRATION_SOURCES);
  const query = list.search;

  const shown = useMemo(
    () => filterIntegrations(active, { query, origins, sources }),
    [active, query, origins, sources],
  );
  const filtering = query.trim() !== "" || origins.length > 0 || sources.length > 0;

  const allColumns = useIntegrationListColumns(connectionCount, spanning);
  const { columns, menu } = useColumnVisibility("integrations", allColumns);
  const empty = filtering ? (
    <NoMatchState message={t("integrations.empty.filtered")} onReset={list.reset} />
  ) : (
    <EmptyState
      icon={Boxes}
      compact
      message={spanning ? t("integrations.empty.across") : t("integrations.empty.space")}
      hint={spanning ? undefined : <SpaceLibraryHint type="integration" />}
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
        actions={actionsMenu}
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
            label: t("integrations.col.source"),
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
          rowHref={(integration) =>
            linkInSpace(packageDetailPath("integration", integration.id), integration.spaceId)
          }
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
              showSpace={spanning}
              meta={
                <>
                  <IntegrationSourceLabel source={integration.source_kind} />
                  {/* An integration that binds no connection has no count to give. */}
                  {integration.authenticated && connectionCount && (
                    <>
                      <span aria-hidden>·</span>
                      <span className="shrink-0">
                        {t("connections.connectionCount", {
                          count: connectionCount(integration.id, integration.spaceIds),
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
          placeholder={<PackageCardSkeleton meta="both" spaceName={spanning} />}
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
      {pickers}
    </div>
  );
}
