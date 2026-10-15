// SPDX-License-Identifier: Apache-2.0

/**
 * The integration index: what this space can use. Like every index it holds the ACTIVE set; one
 * placed here but switched off, or merely offered, is in the space library.
 */

import { useMemo, useState } from "react";
import { catalogueHref } from "../lib/catalogue-link";
import { useTranslation } from "react-i18next";
import { Boxes, LibraryBig, Plus } from "lucide-react";
import { PageHeader } from "../components/page-header";
import { CollectionTabs } from "../components/detail-tabs";
import { DataTable } from "../components/data-table";
import { ListFooter, ListToolbar } from "../components/list-toolbar";
import { EmptyState, EmptyStateAction, NoMatchState } from "../components/page-states";
import { PageActionsMenu } from "../components/page-actions-menu";
import type { MenuAction } from "../lib/menu-action";
import { CreationHandoffModal } from "../components/creation-handoff-modal";
import { SpaceLibraryHint } from "../components/space-library-hint";
import { CreatePackageModal } from "../components/create-package-modal";
import { useCreationHandoff } from "../hooks/use-creation-handoff";
import {
  INTEGRATION_EXECUTIONS,
  INTEGRATION_ORIGINS,
  INTEGRATION_PROTOCOLS,
  integrationExecution,
  type IntegrationExecution,
  filterIntegrations,
} from "../lib/integration-collection";
import { readList, useListParams } from "../lib/list-params";
import { useSearchPlaceholder } from "../lib/search-placeholder";
import { useConnectionCounts } from "../hooks/use-me-connections";
import { usePackageList } from "../hooks/use-packages";
import { usePermissions } from "../hooks/use-permissions";
import { useOrg } from "../hooks/use-org";
import { useColumnVisibility } from "../stores/column-visibility-store";
import { useIntegrationListColumns } from "./integration-list-columns";

export function IntegrationsPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { can } = usePermissions();
  const orgName = useOrg().currentOrg?.name ?? "";
  // The server answers the active set of this space: the index route every
  // type page asks, not the management listing.
  const { data: active = [], isLoading, error } = usePackageList("integration");
  const connectionCounts = useConnectionCounts();
  const list = useListParams(["origin", "protocol"]);
  const searchPlaceholder = useSearchPlaceholder(t("integrations.title"));
  const canCreate = can("integrations:write");
  const canBrowse = can("integrations:install");
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

  const allColumns = useIntegrationListColumns(connectionCounts).filter((column) =>
    execution === "local" ? column.id !== "protocol" : column.id !== "server",
  );
  const { columns, menu } = useColumnVisibility("integrations", allColumns);
  const empty = filtering ? (
    <NoMatchState message={t("integrations.empty.filtered")} />
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
          // A reader has no deed here: no menu, rather than an empty one.
          (canBrowse || canCreate) && (
            <PageActionsMenu
              actions={[
                {
                  id: "catalogue",
                  label: t("catalogue.browse"),
                  icon: LibraryBig,
                  to: catalogueHref("integration"),
                  hidden: !canBrowse,
                },
                createAction,
              ]}
            />
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
              count: isLoading || error ? undefined : countOf(value),
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
        columns={menu}
      />

      <DataTable
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
      <ListFooter
        count={isLoading || error ? undefined : t("integrations.count", { count: shown.length })}
      />

      {creation.isOpen && (
        <CreationHandoffModal
          resource="integration"
          onClose={creation.close}
          onManual={() => {
            creation.close();
            setCreating(true);
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
