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
      header: t("spaces.nameLabel"),
      width: 72,
      elastic: true,
      cell: (client) => <CellText strong>{client.name ?? client.clientId}</CellText>,
    },
    {
      id: "clientId",
      header: t("oauthClients.clientIdColumn"),
      width: 88,
      elastic: true,
      tier: 2,
      cell: (client) => (
        <span className="text-muted-foreground block truncate text-sm" title={client.clientId}>
          {client.clientId}
        </span>
      ),
    },
    {
      id: "type",
      header: t("proxies.col.type"),
      width: 60,
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
      header: t("proxies.col.status"),
      width: 56,
      tier: 2,
      cell: (client) => (
        <Badge variant={client.disabled ? "secondary" : "success"}>
          {client.disabled ? t("oauthClients.disabledBadge") : t("catalogue.filter.active")}
        </Badge>
      ),
    },
    {
      id: "redirectUris",
      header: t("oauthClients.redirectUris"),
      width: 88,
      elastic: true,
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
