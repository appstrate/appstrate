// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";
import { Plug } from "lucide-react";
import { DataTable } from "../data-table";
import { EmptyState } from "../page-states";
import { ListToolbar } from "../list-toolbar";
import { AddIntegrationConnection } from "../integration-connect/add-integration-connection";
import { isOauthAuthConnectable } from "../integration-connect/connectable-auth-keys";
import { isSharedInSpace } from "../integration-connect/connection-ownership";
import { usePermissions } from "../../hooks/use-permissions";
import { useAuth } from "../../hooks/use-auth";
import { useCurrentSpaceId } from "../../hooks/use-current-space";
import { authMethodLabel } from "../../lib/integration-presentation";
import { connectionOptionLabel } from "../../lib/connection-set";
import { useConnectionColumns } from "../../pages/integration-columns";
import type {
  IntegrationAuthStatus,
  IntegrationConnection,
  IntegrationDetailWire,
} from "../../hooks/use-integrations";

/**
 * Connected accounts across all authentication methods.
 *
 * The rows come from the detail query the page already awaits, so the table has
 * no loading or failure of its own to draw — an empty auth is an ANSWER, and it
 * is the only state left for the body to show. Every control on a row lives in
 * its column (`integration-columns.tsx`), which is where the ownership rules
 * that gate them are written down.
 */
export function ConnectionsTable({
  packageId,
  detail,
  canConfigure,
  onConfigure,
  initialMethod,
}: {
  packageId: string;
  detail: IntegrationDetailWire;
  canConfigure: boolean;
  onConfigure: (authKey?: string) => void;
  initialMethod?: string;
}) {
  const { t } = useTranslation("settings");
  const { can } = usePermissions();
  const canConnect = can("integrations:connect");
  // The space's `block_user_connections` gate: the server answers 403
  // `connection_blocked_by_admin`, and `integrations:configure` is exempt.
  const blockedByAdmin = detail.block_user_connections && !canConfigure;
  const [search, setSearch] = useState("");
  const [sharing, setSharing] = useState<string[]>([]);
  const location = useLocation();
  const [methods, setMethods] = useState<string[]>(() => {
    const method = initialMethod ?? new URLSearchParams(location.search).get("connectionMethod");
    return detail.auths.some((auth) => auth.auth_key === method) ? [method!] : [];
  });
  const { user } = useAuth();
  const spaceId = useCurrentSpaceId();
  const connections = detail.auths.flatMap((auth) =>
    auth.connections.map((connection) => ({ ...connection, auth_key: auth.auth_key })),
  );
  const labelFor = (auth: IntegrationAuthStatus) =>
    authMethodLabel(auth, detail.auths, t(`integration.auth.type.${auth.type}`));
  const columns = useConnectionColumns({
    packageId,
    authKey: "",
    authType: "custom",
    canRenew: false,
    manifest: detail.manifest,
    userId: user?.id,
    isAdmin: canConfigure,
    authForConnection: (connection) => {
      const auth = detail.auths.find((item) => item.auth_key === connection.auth_key);
      return {
        authKey: connection.auth_key,
        authType: auth?.type ?? "custom",
        canRenew: auth?.type === "oauth2" && isOauthAuthConnectable(auth),
      };
    },
  });
  const displayColumns = [
    columns[0]!,
    {
      id: "method",
      header: t("integration.presentation.method"),
      width: "minmax(150px,1fr)" as const,
      cell: (connection: IntegrationConnection) => {
        const auth = detail.auths.find((item) => item.auth_key === connection.auth_key);
        return (
          <span className="text-muted-foreground text-xs">
            {auth ? labelFor(auth) : connection.auth_key}
          </span>
        );
      },
    },
    ...columns.slice(1),
  ];
  const rows = connections.filter((connection) => {
    const auth = detail.auths.find((item) => item.auth_key === connection.auth_key);
    return (
      `${connectionOptionLabel(connection)} ${connection.owner_name ?? ""} ${auth ? labelFor(auth) : ""}`
        .toLocaleLowerCase()
        .includes(search.trim().toLocaleLowerCase()) &&
      (sharing.length === 0 ||
        sharing.includes(isSharedInSpace(connection, spaceId) ? "shared" : "private")) &&
      (methods.length === 0 || methods.includes(connection.auth_key))
    );
  });
  return (
    <div data-testid="integration-connections-table">
      <ListToolbar
        placement="panel"
        panelFiltersAdjacent
        search={{
          value: search,
          onChange: setSearch,
          placeholder: t("detail.connectionsTable.search", { ns: "agents" }),
        }}
        filters={[
          {
            id: "sharing",
            label: t("integration.connection.col.shared"),
            values: sharing,
            options: [
              { value: "shared", label: t("detail.sharingShared", { ns: "agents" }) },
              { value: "private", label: t("detail.sharingPrivate", { ns: "agents" }) },
            ],
            onChange: setSharing,
          },
          ...(detail.auths.length > 1
            ? [
                {
                  id: "method",
                  label: t("integration.presentation.method"),
                  values: methods,
                  options: detail.auths.map((auth) => ({
                    value: auth.auth_key,
                    label: labelFor(auth),
                  })),
                  onChange: setMethods,
                },
              ]
            : []),
        ]}
        onReset={() => {
          setSearch("");
          setSharing([]);
          setMethods([]);
        }}
        actions={
          canConfigure || canConnect ? (
            <AddIntegrationConnection
              packageId={packageId}
              detail={detail}
              userId={user?.id}
              onConfigure={onConfigure}
              canConfigure={canConfigure}
              canConnect={canConnect}
              blockedReason={blockedByAdmin ? t("integration.auth.blockedByAdminHint") : undefined}
            />
          ) : undefined
        }
      />
      <DataTable
        surface="integrated"
        columnMode="scroll"
        label={t("integration.connection.tableLabel")}
        columns={displayColumns}
        rows={rows}
        rowKey={(connection) => connection.id}
        empty={
          <EmptyState
            message={t(
              search || sharing.length || methods.length
                ? "integration.presentation.noMatch"
                : "integration.auth.noConnection",
            )}
            icon={Plug}
            compact
          />
        }
      />
    </div>
  );
}
