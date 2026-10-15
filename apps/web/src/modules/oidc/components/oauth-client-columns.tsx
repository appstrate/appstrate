// SPDX-License-Identifier: Apache-2.0

import { Badge } from "@appstrate/ui/components/badge";
import { useTranslation } from "react-i18next";
import type { DataColumn } from "../../../components/data-table";
import { rowActionsColumn } from "../../../components/row-actions-column";
import { CellText } from "../../../components/table-cells";
import type { OAuthClient } from "../hooks/use-oauth-clients";
import { OAuthClientActions } from "./oauth-client-actions";

export function useOAuthClientColumns({
  onEdit,
}: {
  onEdit: (client: OAuthClient) => void;
}): DataColumn<OAuthClient>[] {
  const { t } = useTranslation(["settings", "common"]);

  return [
    {
      id: "client",
      header: t("oauthClients.nameLabel"),
      width: "minmax(72px,1.3fr)",
      cell: (client) => <CellText strong>{client.name ?? client.clientId}</CellText>,
    },
    {
      id: "clientId",
      header: t("oauthClients.clientIdColumn"),
      width: "minmax(88px,1.3fr)",
      tier: 2,
      cell: (client) => (
        <span className="text-muted-foreground block truncate text-sm" title={client.clientId}>
          {client.clientId}
        </span>
      ),
    },
    {
      id: "type",
      header: t("oauthClients.typeColumn"),
      width: "60px",
      tier: 2,
      cell: (client) => (
        <CellText>
          {client.isFirstParty
            ? t("oauthClients.firstPartyBadge")
            : t("oauthClients.standardClient")}
        </CellText>
      ),
    },
    {
      id: "status",
      header: t("oauthClients.statusColumn"),
      width: "56px",
      tier: 2,
      cell: (client) => (
        <Badge variant={client.disabled ? "secondary" : "success"}>
          {client.disabled ? t("oauthClients.disabledBadge") : t("oauthClients.activeBadge")}
        </Badge>
      ),
    },
    {
      id: "redirectUris",
      header: t("oauthClients.redirectUris"),
      width: "minmax(88px,1.4fr)",
      tier: 2,
      cell: (client) => {
        const label = client.redirectUris.join(", ");
        return (
          <span className="text-muted-foreground truncate font-mono text-xs" title={label}>
            {client.redirectUris[0]}
            {client.redirectUris.length > 1 && ` +${client.redirectUris.length - 1}`}
          </span>
        );
      },
    },
    rowActionsColumn((client) => (
      <OAuthClientActions client={client} onEdit={() => onEdit(client)} />
    )),
  ];
}
