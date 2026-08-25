// SPDX-License-Identifier: Apache-2.0

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Boxes, LibraryBig, Plus, Search, SearchX } from "lucide-react";
import { Badge } from "@appstrate/ui/components/badge";
import { Button } from "@appstrate/ui/components/button";
import { Input } from "@appstrate/ui/components/input";
import { DropdownMenuItem } from "@appstrate/ui/components/dropdown-menu";
import { PageHeader } from "../components/page-header";
import { CardGrid } from "../components/card-grid";
import { DataTable, columnMenu, visibleColumns } from "../components/data-table";
import { ListFooter, ListToolbar } from "../components/list-toolbar";
import { PanelDialog } from "../components/panel-dialog";
import { ErrorState, EmptyState } from "../components/page-states";
import { IntegrationIcon } from "../components/integration-icon";
import { PageActionsMenu } from "../components/page-actions-menu";
import { CreationHandoffModal } from "../components/creation-handoff-modal";
import {
  chatDraftNavigationState,
  creationResourceFromSearch,
  creationSearch,
} from "../lib/creation-handoff";
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
  const selectedStatus = statuses.length === 1 ? statuses[0] : "all";
  const statusOptions: Array<{ value: IntegrationStatus; label: string }> = [
    { value: "active", label: t("integrations.badge.active") },
    { value: "inactive", label: t("integrations.badge.inactive") },
  ];
  const statusNavigation: Array<{
    value: "all" | IntegrationStatus;
    label: string;
    statuses: IntegrationStatus[];
  }> = [
    { value: "all", label: t("integrations.catalogue.all"), statuses: [] },
    ...statusOptions.map(({ value, label }) => ({ value, label, statuses: [value] })),
  ];

  const rail = (
    <div data-catalogue-controls="rail" className="flex min-h-full flex-col p-5">
      <div className="flex items-center gap-2">
        <LibraryBig className="text-muted-foreground size-5 shrink-0" />
        <h2 className="font-semibold">{t("integrations.catalogue.title")}</h2>
      </div>
      <p className="text-muted-foreground mt-2 text-sm">
        {t("integrations.catalogue.description")}
      </p>

      <div className="relative mt-5">
        <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
        <Input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={t("integrations.search.placeholder")}
          className="[[data-slot=dialog-content]_&]:bg-background pl-9"
        />
      </div>

      <nav aria-label={t("integrations.catalogue.statusNavigation")} className="mt-3 space-y-1">
        {statusNavigation.map((item) => (
          <Button
            key={item.value}
            type="button"
            variant="ghost"
            size="sm"
            aria-pressed={selectedStatus === item.value}
            className="aria-pressed:bg-accent w-full justify-start px-3"
            onClick={() => onStatusesChange(item.statuses)}
          >
            {item.label}
          </Button>
        ))}
      </nav>
    </div>
  );

  return (
    <PanelDialog title={t("integrations.catalogue.title")} rail={rail} onClose={onClose}>
      <div data-catalogue-controls="mobile" className="md:hidden">
        <div className="mb-5 pr-10">
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
              options: statusOptions,
            },
          ]}
          onReset={onReset}
          placement="panel"
        />
      </div>

      {/* The desktop rail owns every catalogue control. This clear strip keeps
          the card collection below the dialog close control. */}
      <div aria-hidden className="hidden h-6 md:block" />

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
  const creationOpen = creationResourceFromSearch(location.search) === "integration";

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

  const openCatalogue = () =>
    navigate(
      {
        pathname: location.pathname,
        search: catalogueSearch(location.search, true),
        hash: location.hash,
      },
      { state: withCatalogueDepth(location.state, 1) },
    );

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
        wrapActions
        actions={
          <PageActionsMenu>
            <DropdownMenuItem data-page-action="catalogue" onSelect={openCatalogue}>
              <LibraryBig />
              {t("integrations.catalogue.browse")}
            </DropdownMenuItem>
            {isAdmin && (
              <DropdownMenuItem
                data-page-action="create"
                onSelect={() =>
                  navigate(
                    {
                      pathname: location.pathname,
                      search: creationSearch(location.search, "integration"),
                      hash: location.hash,
                    },
                    { state: location.state },
                  )
                }
              >
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

      {creationOpen && (
        <CreationHandoffModal
          resource="integration"
          onClose={() =>
            navigate(
              {
                pathname: location.pathname,
                search: creationSearch(location.search, null),
                hash: location.hash,
              },
              { replace: true, state: location.state },
            )
          }
          onManual={() => navigate("/integrations/new")}
          onChat={(prompt) => navigate("/chat", { state: chatDraftNavigationState(prompt) })}
        />
      )}

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
