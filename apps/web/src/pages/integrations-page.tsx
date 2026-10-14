// SPDX-License-Identifier: Apache-2.0

/**
 * The integration index: what this space can use. Like every index it holds the ACTIVE set; one
 * placed here but switched off, or merely offered, is in the space library.
 */

import { useMemo } from "react";
import { catalogueHref } from "../lib/catalogue-link";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Boxes, LibraryBig, Plus, SearchX } from "lucide-react";
import { DropdownMenuItem } from "@appstrate/ui/components/dropdown-menu";
import { PageHeader } from "../components/page-header";
import { CollectionTabs } from "../components/collection-tabs";
import { CardGrid } from "../components/card-grid";
import { DataTable } from "../components/data-table";
import { columnMenu, visibleColumns } from "../lib/column-visibility";
import { ListFooter, ListToolbar } from "../components/list-toolbar";
import { ErrorState, EmptyState, EmptyStateAction } from "../components/page-states";
import { IntegrationIcon } from "../components/integration-icon";
import { PageActionsMenu } from "../components/page-actions-menu";
import { CreationHandoffModal } from "../components/creation-handoff-modal";
import { SpaceLibraryHint } from "../components/space-library-hint";
import { useCreationHandoff } from "../hooks/use-creation-handoff";
import {
  INTEGRATION_EXECUTIONS,
  INTEGRATION_ORIGINS,
  INTEGRATION_PROTOCOLS,
  integrationExecution,
  type IntegrationExecution,
  filterIntegrations,
  integrationOrigin,
} from "../lib/integration-collection";
import { readList, useListParams } from "../lib/list-params";
import { useSearchPlaceholder } from "../lib/search-placeholder";
import { usePackageList } from "../hooks/use-packages";
import { usePermissions } from "../hooks/use-permissions";
import { useOrg } from "../hooks/use-org";
import { useColumnVisibility } from "../stores/column-visibility-store";
import { useListView } from "../stores/list-view-store";
import { useIntegrationListColumns } from "./integration-list-columns";
import type { IntegrationIndexItem } from "@appstrate/shared-types";

function IntegrationCard({
  integration,
  orgName,
}: {
  integration: IntegrationIndexItem;
  orgName: string;
}) {
  const { t } = useTranslation("settings");
  const origin = integrationOrigin(integration);

  return (
    <Link
      to={`/integrations/${integration.id}`}
      data-testid="integration-card"
      data-integration-id={integration.id}
      className="bg-card hover:border-primary/40 flex flex-col rounded-lg border p-4 transition-colors hover:shadow-md"
    >
      <div className="flex items-start gap-3">
        <IntegrationIcon src={integration.icon ?? undefined} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold">{integration.name}</h3>
          <p className="text-muted-foreground truncate text-xs">
            {origin === "system" ? t("catalogue.sourceSystem") : orgName}
            {integration.version ? ` · ${integration.version}` : ""}
          </p>
        </div>
      </div>
      {integration.description && (
        <p className="text-muted-foreground mt-3 line-clamp-2 text-sm">{integration.description}</p>
      )}
    </Link>
  );
}

export function IntegrationsPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { can } = usePermissions();
  const orgName = useOrg().currentOrg?.name ?? "";
  // The server answers the active set of this space: the index route every
  // type page asks, not the management listing.
  const { data: active = [], isLoading, error } = usePackageList("integration");
  const list = useListParams(["origin", "protocol"]);
  const [view, setView] = useListView("integrations");
  const visibility = useColumnVisibility("integrations");
  const searchPlaceholder = useSearchPlaceholder(t("integrations.title"));
  const canCreate = can("integrations:write");
  const canBrowse = can("integrations:install");
  const creation = useCreationHandoff("integration", canCreate);

  const origins = list.values("origin", INTEGRATION_ORIGINS);
  // The execution is a tab, not a filter: it splits the collection in two
  // kinds of object, and the columns that make sense differ between them.
  const execution: IntegrationExecution =
    list.params.get("execution") === "local" ? "local" : "remote";
  const protocolParam = list.params.get("protocol");
  const protocols = useMemo(
    () =>
      execution === "remote"
        ? readList(protocolParam, INTEGRATION_PROTOCOLS)
        : ([] as (typeof INTEGRATION_PROTOCOLS)[number][]),
    [execution, protocolParam],
  );
  const query = list.search;

  const shown = useMemo(
    () =>
      filterIntegrations(active, {
        query,
        origins,
        executions: [execution],
        protocols,
      }),
    [active, query, origins, execution, protocols],
  );
  const filtering = query.trim() !== "" || origins.length > 0 || protocols.length > 0;
  const countOf = (value: IntegrationExecution) =>
    active.filter((row) => integrationExecution(row.source_kind) === value).length;

  const allColumns = useIntegrationListColumns().filter((column) =>
    execution === "local" ? column.id !== "protocol" : column.id !== "server",
  );
  const columns = visibleColumns(allColumns, visibility.hidden);
  const empty = (
    <EmptyState
      icon={filtering ? SearchX : Boxes}
      compact
      message={filtering ? t("integrations.empty.filtered") : t("integrations.empty.space")}
      hint={filtering ? undefined : <SpaceLibraryHint type="integration" />}
    >
      {!filtering && canCreate && (
        <EmptyStateAction label={t("integrations.create")} onClick={creation.open} />
      )}
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
          // A reader has no deed here: no menu, rather than an empty one.
          (canBrowse || canCreate) && (
            <PageActionsMenu>
              {canBrowse && (
                <DropdownMenuItem asChild data-page-action="catalogue">
                  <Link to={catalogueHref("integration")}>
                    <LibraryBig />
                    {t("catalogue.browse")}
                  </Link>
                </DropdownMenuItem>
              )}
              {canCreate && (
                <DropdownMenuItem data-page-action="create" onSelect={creation.open}>
                  <Plus />
                  {t("integrations.create")}
                </DropdownMenuItem>
              )}
            </PageActionsMenu>
          )
        }
      >
        <p className="text-muted-foreground mt-1 text-sm">{t("integrations.subtitle")}</p>
      </PageHeader>

      <ListToolbar
        tabs={
          <CollectionTabs
            value={execution}
            label={t("integrations.execution.label")}
            // One URL update: two in the same tick read the same location and
            // the second would undo the first (see `useListParams`). A protocol
            // filter left in the URL is simply not applied on the local tab.
            onChange={(next) => list.setValues("execution")(next === "local" ? ["local"] : [])}
            options={INTEGRATION_EXECUTIONS.map((value) => ({
              value,
              label: t(`integrations.execution.${value}`),
              count: countOf(value),
            }))}
          />
        }
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
          ...(execution === "remote"
            ? [
                {
                  id: "protocol",
                  label: t("integrations.filter.protocol"),
                  values: protocols,
                  onChange: list.setValues("protocol"),
                  options: INTEGRATION_PROTOCOLS.map((protocol) => ({
                    value: protocol,
                    label: t(`integrations.protocol.${protocol}`),
                  })),
                },
              ]
            : []),
        ]}
        onReset={list.reset}
        columns={view === "table" ? columnMenu(allColumns, visibility) : undefined}
        view={view}
        onViewChange={setView}
      />

      {view === "table" ? (
        <DataTable
          tableId="integrations"
          label={t("integrations.tableLabel")}
          columns={columns}
          columnMode="scroll"
          rows={shown}
          rowKey={(integration) => integration.id}
          rowHref={(integration) => `/integrations/${integration.id}`}
          rowLabel={(integration) => integration.name}
          isLoading={isLoading}
          isError={Boolean(error)}
          error={<ErrorState error={error} compact />}
          empty={empty}
        />
      ) : (
        <CardGrid
          items={shown}
          itemKey={(integration) => integration.id}
          renderCard={(integration) => (
            <IntegrationCard integration={integration} orgName={orgName} />
          )}
          isLoading={isLoading}
          isError={Boolean(error)}
          error={<ErrorState error={error} compact />}
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
          onManual={() => creation.leave("/integrations/new")}
          onChat={creation.openChat}
        />
      )}
    </div>
  );
}
