// SPDX-License-Identifier: Apache-2.0

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Boxes, LibraryBig, Plus, SearchX } from "lucide-react";
import { Badge } from "@appstrate/ui/components/badge";
import { DropdownMenuItem } from "@appstrate/ui/components/dropdown-menu";
import { PageHeader } from "../components/page-header";
import { CardGrid } from "../components/card-grid";
import { DataTable, columnMenu, visibleColumns } from "../components/data-table";
import { ListFooter, ListToolbar } from "../components/list-toolbar";
import { ErrorState, EmptyState } from "../components/page-states";
import { IntegrationIcon } from "../components/integration-icon";
import { PageActionsMenu } from "../components/page-actions-menu";
import { CreationHandoffModal } from "../components/creation-handoff-modal";
import { useCreationHandoff } from "../hooks/use-creation-handoff";
import {
  INTEGRATION_ORIGINS,
  INTEGRATION_STATUSES,
  filterIntegrations,
  integrationOrigin,
  integrationStatus,
  isOrganizationIntegration,
} from "../lib/integration-collection";
import { useListParams } from "../lib/list-params";
import { openAsModal } from "../lib/modal-route";
import { useSearchPlaceholder } from "../lib/search-placeholder";
import { useAllIntegrations, type IntegrationSummaryWire } from "../hooks/use-integrations";
import { usePermissions } from "../hooks/use-permissions";
import { useColumnVisibility } from "../stores/column-visibility-store";
import { useIntegrationViewStore } from "../stores/list-view-store";
import { useIntegrationListColumns } from "./integration-list-columns";

function IntegrationCard({ integration }: { integration: IntegrationSummaryWire }) {
  const { t } = useTranslation("settings");
  const manifest = integration.manifest;
  const origin = integrationOrigin(integration);
  const status = integrationStatus(integration);

  return (
    <Link
      to={`/integrations/${integration.id}`}
      data-testid="integration-card"
      data-integration-id={integration.id}
      className="bg-card hover:border-primary/40 flex flex-col rounded-lg border p-4 transition-colors hover:shadow-md"
    >
      <div className="flex items-start gap-3">
        <IntegrationIcon src={manifest.icon} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold">
            {manifest.display_name ?? integration.id}
          </h3>
          <p className="text-muted-foreground truncate text-xs">
            {t(origin === "system" ? "integrations.origin.system" : "integrations.origin.custom")}
            {manifest.version ? ` · ${manifest.version}` : ""}
          </p>
        </div>
        <Badge variant={status === "active" ? "success" : "secondary"}>
          {t(status === "active" ? "integrations.badge.active" : "integrations.badge.inactive")}
        </Badge>
      </div>
      {manifest.description && (
        <p className="text-muted-foreground mt-3 line-clamp-2 text-sm">{manifest.description}</p>
      )}
    </Link>
  );
}

export function IntegrationsPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { can } = usePermissions();
  const { data, isLoading, error } = useAllIntegrations();
  const location = useLocation();
  const navigate = useNavigate();
  const list = useListParams(["status", "origin"]);
  const view = useIntegrationViewStore((state) => state.view);
  const setView = useIntegrationViewStore((state) => state.setView);
  const visibility = useColumnVisibility("integrations");
  const searchPlaceholder = useSearchPlaceholder(t("integrations.title"));
  const creation = useCreationHandoff("integration", can("integrations:write"));

  const statuses = list.values("status", INTEGRATION_STATUSES);
  const origins = list.values("origin", INTEGRATION_ORIGINS);
  const query = list.search;

  const organizationIntegrations = useMemo(
    () => (data ?? []).filter(isOrganizationIntegration),
    [data],
  );
  const shown = useMemo(
    () => filterIntegrations(organizationIntegrations, { query, statuses, origins }),
    [organizationIntegrations, query, statuses, origins],
  );
  const filtering = query.trim() !== "" || statuses.length > 0 || origins.length > 0;

  const openIntegration = (integration: IntegrationSummaryWire) =>
    navigate(`/integrations/${integration.id}`);
  const allColumns = useIntegrationListColumns({ onOpen: openIntegration });
  const columns = visibleColumns(allColumns, visibility.hidden);
  const empty = (
    <EmptyState
      icon={filtering ? SearchX : Boxes}
      compact
      message={filtering ? t("integrations.empty.filtered") : t("integrations.empty.organization")}
    />
  );

  return (
    <div>
      <PageHeader
        title={t("integrations.title")}
        variant="collection"
        breadcrumbs={[{ label: t("integrations.title") }]}
        wrapActions
        actions={
          <PageActionsMenu>
            {can("integrations:install") && (
              <DropdownMenuItem asChild data-page-action="catalogue">
                <Link to="/catalogue/org/integration" state={openAsModal(location)}>
                  <LibraryBig />
                  {t("catalogue.browse")}
                </Link>
              </DropdownMenuItem>
            )}
            {can("integrations:write") && (
              <DropdownMenuItem data-page-action="create" onSelect={creation.open}>
                <Plus />
                {t("integrations.create")}
              </DropdownMenuItem>
            )}
          </PageActionsMenu>
        }
      >
        <p className="text-muted-foreground mt-1 text-sm">{t("integrations.subtitle")}</p>
      </PageHeader>

      <ListToolbar
        search={{ value: query, onChange: list.setSearch, placeholder: searchPlaceholder }}
        filters={[
          {
            id: "status",
            label: t("integrations.filter.status"),
            values: statuses,
            onChange: list.setValues("status"),
            options: [
              { value: "active", label: t("integrations.badge.active") },
              { value: "inactive", label: t("integrations.badge.inactive") },
            ],
          },
          {
            id: "origin",
            label: t("integrations.filter.origin"),
            values: origins,
            onChange: list.setValues("origin"),
            options: [
              { value: "system", label: t("integrations.origin.system") },
              { value: "custom", label: t("integrations.origin.custom") },
            ],
          },
        ]}
        onReset={list.reset}
        columns={view === "table" ? columnMenu(allColumns, visibility) : undefined}
        view={view}
        onViewChange={setView}
      />

      {view === "table" ? (
        <DataTable
          label={t("integrations.tableLabel")}
          columns={columns}
          columnMode="scroll"
          rows={shown}
          rowKey={(integration) => integration.id}
          rowHref={(integration) => `/integrations/${integration.id}`}
          rowLabel={(integration) => integration.manifest.display_name ?? integration.id}
          isLoading={isLoading}
          isError={Boolean(error)}
          error={
            <ErrorState message={error instanceof Error ? error.message : undefined} compact />
          }
          empty={empty}
        />
      ) : (
        <CardGrid
          items={shown}
          itemKey={(integration) => integration.id}
          renderCard={(integration) => <IntegrationCard integration={integration} />}
          isLoading={isLoading}
          isError={Boolean(error)}
          error={
            <ErrorState message={error instanceof Error ? error.message : undefined} compact />
          }
          empty={empty}
        />
      )}
      <ListFooter
        count={isLoading || error ? undefined : t("integrations.count", { count: shown.length })}
      />

      {creation.isOpen && (
        <CreationHandoffModal
          resource="integration"
          onClose={creation.close}
          onManual={() => navigate("/integrations/new")}
          onChat={creation.openChat}
        />
      )}
    </div>
  );
}
