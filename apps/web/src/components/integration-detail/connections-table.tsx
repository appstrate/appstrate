// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Plug } from "lucide-react";
import { DataTable } from "../data-table";
import { EmptyState } from "../page-states";
import { ListToolbar } from "../list-toolbar";
import { AddIntegrationConnection } from "../integration-connect/add-integration-connection";
import { isOauthAuthConnectable } from "../integration-connect/connectable-auth-keys";
import { usePermissions } from "../../hooks/use-permissions";
import { useAuth } from "../../hooks/use-auth";
import { authMethodLabel } from "../../lib/integration-presentation";
import { connectionOptionLabel } from "../../lib/connection-set";
import { useConsumedSearchParam } from "../../hooks/use-consumed-search-param";
import { useLocalListParams } from "../../lib/list-params";
import { matchesSearch } from "../../lib/strings";
import { useConnectionColumns } from "./integration-columns";
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
}: {
  packageId: string;
  detail: IntegrationDetailWire;
  canConfigure: boolean;
  onConfigure: (authKey?: string) => void;
}) {
  const { t } = useTranslation("settings");
  const { can } = usePermissions();
  const canConnect = can("integrations:connect");
  // The space's `block_user_connections` gate: the server answers 403
  // `connection_blocked_by_admin`, and `integrations:configure` is exempt.
  const blockedByAdmin = detail.block_user_connections && !canConfigure;
  // `?connectionMethod` opens the table filtered once (« see the connections » of a method); the
  // table is remounted at every tab switch, so the parameter is consumed rather than re-applied.
  const method = useConsumedSearchParam("connectionMethod");
  const list = useLocalListParams(
    detail.auths.some((auth) => auth.auth_key === method) ? { method: [method!] } : {},
  );
  const sharing = list.values("sharing", ["shared", "private"] as const);
  const methods = list.values(
    "method",
    detail.auths.map((auth) => auth.auth_key),
  );
  const { user } = useAuth();
  const connections = detail.auths.flatMap((auth) =>
    auth.connections.map((connection) => ({ ...connection, auth_key: auth.auth_key })),
  );
  const labelFor = (auth: IntegrationAuthStatus) =>
    authMethodLabel(auth, detail.auths, t(`integration.auth.type.${auth.type}`));
  const authOf = (connection: IntegrationConnection) =>
    detail.auths.find((item) => item.auth_key === connection.auth_key);
  const columns = useConnectionColumns({
    packageId,
    manifest: detail.manifest,
    userId: user?.id,
    isAdmin: canConfigure,
    methodLabel: (connection) => {
      const auth = authOf(connection);
      return auth ? labelFor(auth) : connection.auth_key;
    },
    authForConnection: (connection) => {
      const auth = authOf(connection);
      return {
        authKey: connection.auth_key,
        authType: auth?.type ?? "custom",
        canRenew: auth?.type === "oauth2" && isOauthAuthConnectable(auth),
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
      (sharing.length === 0 || sharing.includes(connection.shared_here ? "shared" : "private")) &&
      (methods.length === 0 || methods.includes(connection.auth_key))
    );
  });
  return (
    <div data-testid="integration-connections-table">
      <ListToolbar
        placement="panel"
        search={{
          value: list.search,
          onChange: list.setSearch,
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
            onChange: list.setValues("sharing"),
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
                  onChange: list.setValues("method"),
                },
              ]
            : []),
        ]}
        onReset={list.reset}
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
        tiered
        surface="integrated"
        label={t("integration.connection.tableLabel")}
        columns={columns}
        rows={rows}
        rowKey={(connection) => connection.id}
        empty={
          <EmptyState
            message={t(
              list.search || sharing.length || methods.length
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
