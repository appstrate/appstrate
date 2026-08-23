// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { ShieldCheck } from "lucide-react";
import { Badge } from "@appstrate/ui/components/badge";
import type { DataColumn } from "../../../components/data-table";
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
      width: "minmax(160px,1.5fr)",
      cell: (client) => (
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-medium">{client.name ?? client.clientId}</span>
            {client.isFirstParty && (
              <Badge variant="outline">
                <ShieldCheck className="mr-1 h-3 w-3" />
                {t("oauthClients.firstPartyBadge")}
              </Badge>
            )}
            {client.disabled && (
              <Badge variant="secondary">{t("oauthClients.disabledBadge")}</Badge>
            )}
          </div>
          <div className="text-muted-foreground truncate font-mono text-xs" title={client.clientId}>
            {client.clientId}
          </div>
        </div>
      ),
    },
    {
      id: "redirectUris",
      header: t("oauthClients.redirectUris"),
      width: "minmax(180px,1.5fr)",
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
    {
      id: "actions",
      header: "",
      width: "80px",
      align: "end",
      cell: (client) => <OAuthClientActions client={client} onEdit={() => onEdit(client)} />,
    },
  ];
}
