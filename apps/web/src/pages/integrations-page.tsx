// SPDX-License-Identifier: Apache-2.0

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Boxes, LibraryBig, Plus, SearchX } from "lucide-react";
import { Badge } from "@appstrate/ui/components/badge";
import { Button } from "@appstrate/ui/components/button";
import { PageHeader } from "../components/page-header";
import { CardGrid } from "../components/card-grid";
import { DataTable, columnMenu, visibleColumns } from "../components/data-table";
import { ListFooter, ListToolbar } from "../components/list-toolbar";
import { PanelDialog } from "../components/panel-dialog";
import { ErrorState, EmptyState } from "../components/page-states";
import { IntegrationIcon } from "../components/integration-icon";
import { TOOLBAR_ACTION, TOOLBAR_UTILITY } from "../lib/toolbar-button";
import {
  INTEGRATION_ORIGINS,
  INTEGRATION_STATUSES,
  catalogueFilterSearch,
  catalogueSearch,
  filterIntegrations,
  integrationOrigin,
  integrationStatus,
  isCatalogueIntegration,
  isOrganizationIntegration,
  readCatalogueFilters,
  type IntegrationStatus,
} from "../lib/integration-collection";
import { useListParams } from "../lib/list-params";
import { useSearchPlaceholder } from "../lib/search-placeholder";
import { useAllIntegrations, type IntegrationSummaryWire } from "../hooks/use-integrations";
import { usePermissions } from "../hooks/use-permissions";
import { useColumnVisibility } from "../stores/column-visibility-store";
import { useIntegrationViewStore } from "../stores/list-view-store";
import { useIntegrationListColumns } from "./integration-list-columns";

function catalogueDepth(state: unknown): number {
  if (!state || typeof state !== "object" || !("catalogueDepth" in state)) return 0;
  const depth = (state as { catalogueDepth?: unknown }).catalogueDepth;
  return typeof depth === "number" && Number.isInteger(depth) && depth > 0 ? depth : 0;
}

function withCatalogueDepth(state: unknown, depth: number): Record<string, unknown> {
  return {
    ...(state && typeof state === "object" ? state : {}),
    catalogueDepth: depth,
  };
}

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

function CataloguePanel({
  integrations,
  isLoading,
  error,
  query,
  statuses,
  onQueryChange,
  onStatusesChange,
  onReset,
  onClose,
}: {
  integrations: IntegrationSummaryWire[];
  isLoading: boolean;
  error: unknown;
  query: string;
  statuses: IntegrationStatus[];
  onQueryChange: (query: string) => void;
  onStatusesChange: (statuses: IntegrationStatus[]) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);

  const shown = useMemo(
    () => filterIntegrations(integrations, { query, statuses }),
    [integrations, query, statuses],
  );
  const filtering = query.trim() !== "" || statuses.length > 0;

  const rail = (
    <div className="p-5">
      <div className="bg-background mb-4 grid size-10 place-items-center rounded-lg border">
        <LibraryBig className="text-muted-foreground size-5" />
      </div>
      <h2 className="font-semibold">{t("integrations.catalogue.title")}</h2>
      <p className="text-muted-foreground mt-2 text-sm">
        {t("integrations.catalogue.description")}
      </p>
    </div>
  );

  return (
    <PanelDialog title={t("integrations.catalogue.title")} rail={rail} onClose={onClose}>
      <div className="mb-5 md:hidden">
        <h2 className="text-lg font-semibold">{t("integrations.catalogue.title")}</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          {t("integrations.catalogue.description")}
        </p>
      </div>

      <ListToolbar
        search={{
          value: query,
          onChange: onQueryChange,
          placeholder: t("integrations.search.placeholder"),
        }}
        filters={[
          {
            id: "status",
            label: t("integrations.filter.status"),
            values: statuses,
            onChange: (values) => onStatusesChange(values as IntegrationStatus[]),
            options: [
              { value: "active", label: t("integrations.badge.active") },
              { value: "inactive", label: t("integrations.badge.inactive") },
            ],
          },
        ]}
        onReset={onReset}
      />

      <CardGrid
        items={shown}
        itemKey={(integration) => integration.id}
        renderCard={(integration) => <IntegrationCard integration={integration} />}
        isLoading={isLoading}
        isError={Boolean(error)}
        error={<ErrorState message={error instanceof Error ? error.message : undefined} compact />}
        empty={
          <EmptyState
            icon={filtering ? SearchX : Boxes}
            compact
            message={
              filtering ? t("integrations.empty.filtered") : t("integrations.catalogue.empty")
            }
          />
        }
      />
      <ListFooter
        count={isLoading || error ? undefined : t("integrations.count", { count: shown.length })}
      />
    </PanelDialog>
  );
}

export function IntegrationsPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { isAdmin } = usePermissions();
  const { data, isLoading, error } = useAllIntegrations();
  const location = useLocation();
  const navigate = useNavigate();
  const list = useListParams(["status", "origin"]);
  const view = useIntegrationViewStore((state) => state.view);
  const setView = useIntegrationViewStore((state) => state.setView);
  const visibility = useColumnVisibility("integrations");
  const searchPlaceholder = useSearchPlaceholder(t("integrations.title"));

  const statuses = list.values("status", INTEGRATION_STATUSES);
  const origins = list.values("origin", INTEGRATION_ORIGINS);
  const query = list.search;

  const organizationIntegrations = useMemo(
    () => (data ?? []).filter(isOrganizationIntegration),
    [data],
  );
  const catalogueIntegrations = useMemo(() => (data ?? []).filter(isCatalogueIntegration), [data]);
  const shown = useMemo(
    () => filterIntegrations(organizationIntegrations, { query, statuses, origins }),
    [organizationIntegrations, query, statuses, origins],
  );
  const filtering = query.trim() !== "" || statuses.length > 0 || origins.length > 0;

  const openIntegration = (integration: IntegrationSummaryWire) =>
    navigate(`/integrations/${integration.id}`);
  const allColumns = useIntegrationListColumns({ onOpen: openIntegration });
  const columns = visibleColumns(allColumns, visibility.hidden);
  const catalogueOpen = new URLSearchParams(location.search).get("catalogue") === "1";
  const catalogueFilters = readCatalogueFilters(location.search);
  const historyDepth = catalogueDepth(location.state);

  const setCatalogueFilters = (
    next: { query: string; statuses: IntegrationStatus[] },
    replace: boolean,
  ) => {
    navigate(
      {
        pathname: location.pathname,
        search: catalogueFilterSearch(location.search, next),
        hash: location.hash,
      },
      {
        replace,
        state: replace ? location.state : withCatalogueDepth(location.state, historyDepth + 1),
      },
    );
  };

  const closeCatalogue = () => {
    if (historyDepth > 0) {
      navigate(-historyDepth);
      return;
    }
    navigate(
      {
        pathname: location.pathname,
        search: catalogueSearch(location.search, false),
        hash: location.hash,
      },
      { replace: true },
    );
  };

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
        emoji="🧩"
        title={t("integrations.title")}
        breadcrumbs={[{ label: t("integrations.title") }]}
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
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={TOOLBAR_UTILITY}
              title={t("integrations.catalogue.browse")}
              onClick={() =>
                navigate(
                  {
                    pathname: location.pathname,
                    search: catalogueSearch(location.search, true),
                    hash: location.hash,
                  },
                  { state: withCatalogueDepth(location.state, 1) },
                )
              }
            >
              <LibraryBig />
              <span className="hidden @xl/bar:inline">{t("integrations.catalogue.browse")}</span>
            </Button>
            {isAdmin && (
              <Button asChild variant="outline" size="sm" className={TOOLBAR_ACTION}>
                <Link to="/integrations/new" title={t("integrations.createCustom")}>
                  <Plus />
                  <span className="hidden @lg/bar:inline">{t("integrations.createCustom")}</span>
                </Link>
              </Button>
            )}
          </>
        }
      />

      {view === "table" ? (
        <DataTable
          label={t("integrations.tableLabel")}
          columns={columns}
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

      {catalogueOpen && (
        <CataloguePanel
          integrations={catalogueIntegrations}
          isLoading={isLoading}
          error={error}
          query={catalogueFilters.query}
          statuses={catalogueFilters.statuses}
          onQueryChange={(nextQuery) =>
            setCatalogueFilters({ query: nextQuery, statuses: catalogueFilters.statuses }, true)
          }
          onStatusesChange={(nextStatuses) =>
            setCatalogueFilters(
              { query: catalogueFilters.query, statuses: nextStatuses },
              historyDepth === 0,
            )
          }
          onReset={() => setCatalogueFilters({ query: "", statuses: [] }, historyDepth === 0)}
          onClose={closeCatalogue}
        />
      )}
    </div>
  );
}
