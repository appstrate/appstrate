// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Plug } from "lucide-react";
import { DataTable } from "../data-table";
import { EmptyState, NoMatchState } from "../page-states";
import { ListToolbar, type FilterSpec } from "../list-toolbar";
import { SpaceTile } from "../space-name";
import { AddIntegrationConnection } from "../integration-connect/add-integration-connection";
import { isOauthAuthConnectable } from "../integration-connect/connectable-auth-keys";
import { isConnectionOwnedBy } from "../integration-connect/connection-ownership";
import { usePermissions, useRowSpaceGrants } from "../../hooks/use-permissions";
import { useAuth } from "../../hooks/use-auth";
import { useCurrentSpaceId } from "../../hooks/use-current-space";
import { useSpaces } from "../../hooks/use-spaces";
import { authMethodLabel } from "../../lib/integration-presentation";
import { connectionOptionLabel } from "../../lib/connection-set";
import { connectionRows, type ConnectionRow } from "../../lib/connection-rows";
import { spaceLabel } from "../../lib/space-label";
import { useConsumedSearchParam } from "../../hooks/use-consumed-search-param";
import { useLocalListParams } from "../../lib/list-params";
import { matchesSearch } from "../../lib/strings";
import { useConnectionColumns } from "./integration-columns";
import type {
  IntegrationAuthStatus,
  IntegrationDetailIn,
  IntegrationDetailWire,
} from "../../hooks/use-integrations";

/**
 * Connected accounts across all authentication methods, and in « Tous les espaces » across every
 * space the integration is active in where the reader reads it: one row per connection
 * (`connectionRows`), naming its spaces, its controls acting in the space it is read from.
 *
 * The rows come from details already awaited, so the table has no loading or failure of its own
 * to draw — an empty auth is an ANSWER, and it is the only state left for the body to show. Every
 * control on a row lives in its column (`integration-columns.tsx`), which is where the ownership
 * rules that gate them are written down.
 */
export function ConnectionsTable({
  packageId,
  sources,
  spanning,
  addIn,
  onConfigure,
}: {
  packageId: string;
  /** One read per space listed; the working space's alone outside « Tous les espaces ». */
  sources: readonly IntegrationDetailIn[];
  spanning: boolean;
  /** The working space's detail, where « Ajouter » connects; absent where it cannot. */
  addIn?: { detail: IntegrationDetailWire; canConfigure: boolean };
  onConfigure: (authKey?: string) => void;
}) {
  const { t } = useTranslation("settings");
  const { can } = usePermissions();
  const grants = useRowSpaceGrants();
  const currentSpaceId = useCurrentSpaceId();
  const { data: spaces } = useSpaces();
  const { user } = useAuth();
  const canConnect = can("integrations:connect");
  // The space's `block_user_connections` gate: the server answers 403
  // `connection_blocked_by_admin`, and `integrations:configure` is exempt.
  const blockedByAdmin = !!addIn && addIn.detail.block_user_connections && !addIn.canConfigure;
  const detailOf = new Map(sources.map((source) => [source.spaceId, source.detail]));
  // Every method any listed space reads, once: the home space reads the draft, the others the
  // latest published version, so their auths may differ. A row resolves its own (`authOf`).
  const auths = [
    ...new Map(
      sources.flatMap(({ detail }) => detail.auths).map((auth) => [auth.auth_key, auth]),
    ).values(),
  ];
  // `?connectionMethod` opens the table filtered once (« see the connections » of a method); the
  // table is remounted at every tab switch, so the parameter is consumed rather than re-applied.
  const method = useConsumedSearchParam("connectionMethod");
  const list = useLocalListParams(
    auths.some((auth) => auth.auth_key === method) ? { method: [method!] } : {},
  );
  const owners = list.values("owner", ["me"] as const);
  const methods = list.values(
    "method",
    auths.map((auth) => auth.auth_key),
  );
  const spaceIds = sources.map((source) => source.spaceId);
  const pickedSpaces = list.values("space", spaceIds);
  const connections = connectionRows(sources, currentSpaceId);
  const authOf = (connection: ConnectionRow) =>
    detailOf.get(connection.rowSpaceId)?.auths.find((a) => a.auth_key === connection.auth_key);
  const labelFor = (auth: IntegrationAuthStatus) =>
    authMethodLabel(auth, auths, t(`integration.auth.type.${auth.type}`));
  const isAdminOf = (connection: ConnectionRow) =>
    grants(connection.rowSpaceId, "integrations:configure");
  const columns = useConnectionColumns({
    packageId,
    manifestOf: (connection) => detailOf.get(connection.rowSpaceId)!.manifest,
    userId: user?.id,
    isAdminOf,
    spanning,
    methodLabel: (connection) => {
      const auth = authOf(connection);
      return auth ? labelFor(auth) : connection.auth_key;
    },
    authForConnection: (connection) => {
      const auth = authOf(connection);
      const methodReady = !!auth && (auth.type !== "oauth2" || isOauthAuthConnectable(auth));
      const blocked =
        !!detailOf.get(connection.rowSpaceId)?.block_user_connections && !isAdminOf(connection);
      return {
        authKey: connection.auth_key,
        methodReady,
        canRenew: methodReady && (connection.allowed_actions ?? []).includes("reconnect"),
        canCreate: methodReady && grants(connection.rowSpaceId, "integrations:connect") && !blocked,
      };
    },
  });
  const rows = connections.filter((connection) => {
    const auth = authOf(connection);
    return (
      matchesSearch(list.search, [
        connectionOptionLabel(connection),
        connection.owner_name,
        auth ? labelFor(auth) : null,
      ]) &&
      (owners.length === 0 || isConnectionOwnedBy(connection, user?.id)) &&
      (methods.length === 0 || methods.includes(connection.auth_key)) &&
      (pickedSpaces.length === 0 ||
        connection.rowSpaceIds.some((spaceId) => pickedSpaces.includes(spaceId)))
    );
  });
  const listedSpaces = spanning
    ? (spaces ?? []).filter((space) => spaceIds.includes(space.id))
    : [];
  const filters: FilterSpec[] = [
    ...(listedSpaces.length > 1
      ? [
          {
            id: "space",
            label: t("spaceFilter.label", { ns: "common" }),
            values: pickedSpaces,
            options: listedSpaces.map((space) => ({
              value: space.id,
              label: spaceLabel(space, t),
              icon: <SpaceTile space={space} />,
            })),
            onChange: list.setValues("space"),
          },
        ]
      : []),
    {
      id: "owner",
      label: t("integration.connection.col.owner"),
      values: owners,
      options: [{ value: "me", label: t("integration.connection.filterMine") }],
      onChange: list.setValues("owner"),
    },
    ...(auths.length > 1
      ? [
          {
            id: "method",
            label: t("integration.presentation.method"),
            values: methods,
            options: auths.map((auth) => ({
              value: auth.auth_key,
              label: labelFor(auth),
            })),
            onChange: list.setValues("method"),
          },
        ]
      : []),
  ];
  return (
    <div data-testid="integration-connections-table">
      <ListToolbar
        search={{
          value: list.search,
          onChange: list.setSearch,
          placeholder: t("detail.connectionsTable.search", { ns: "agents" }),
        }}
        filters={filters}
        onReset={list.reset}
        actions={
          addIn && (addIn.canConfigure || canConnect) ? (
            <AddIntegrationConnection
              packageId={packageId}
              detail={addIn.detail}
              userId={user?.id}
              onConfigure={onConfigure}
              canConfigure={addIn.canConfigure}
              canConnect={canConnect}
              blockedReason={blockedByAdmin ? t("integration.auth.blockedByAdminHint") : undefined}
            />
          ) : undefined
        }
      />
      <DataTable
        tableId="integration-connections"
        label={t("integration.connection.tableLabel")}
        columns={columns}
        rows={rows}
        rowKey={(connection) => connection.id}
        empty={
          list.search || owners.length || methods.length || pickedSpaces.length ? (
            <NoMatchState message={t("integration.presentation.noMatch")} onReset={list.reset} />
          ) : (
            <EmptyState message={t("integration.auth.noConnection")} icon={Plug} compact />
          )
        }
      />
    </div>
  );
}
