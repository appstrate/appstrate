// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import type { DataColumn } from "../components/data-table";
import { IntegrationIcon } from "../components/integration-icon";
import {
  useCatalogueOriginColumn,
  useCatalogueProtocolColumn,
} from "../components/catalogue-columns";
import type { IntegrationSummaryWire } from "../hooks/use-integrations";
import { useOrg } from "../hooks/use-org";
import { integrationProtocol, localServerRef } from "../lib/integration-collection";

/** One comparable integration fact per column. */
export function useIntegrationListColumns(): DataColumn<IntegrationSummaryWire>[] {
  const { t } = useTranslation("settings");
  const origin = useCatalogueOriginColumn<IntegrationSummaryWire>(useOrg().currentOrg?.name ?? "");
  // Remote tab only: API or MCP.
  const protocol = useCatalogueProtocolColumn<IntegrationSummaryWire>(integrationProtocol);

  return [
    {
      id: "name",
      header: t("integrations.col.name"),
      width: "minmax(132px,1.6fr)",
      cell: (integration) => (
        <div className="flex min-w-0 items-center gap-2">
          <IntegrationIcon src={integration.manifest.icon} size="sm" />
          <span className="truncate font-medium">
            {integration.manifest.display_name ?? integration.id}
          </span>
        </div>
      ),
    },
    origin,
    protocol,
    {
      // Local tab only: the server package the sandbox runs.
      id: "server",
      header: t("integrations.col.server"),
      width: "minmax(140px,1fr)",
      tier: 3,
      cell: (integration) => {
        const server = localServerRef(integration);
        return (
          <span className="text-muted-foreground truncate font-mono text-xs">
            {server ? `${server.name}${server.version ? ` ${server.version}` : ""}` : "—"}
          </span>
        );
      },
    },
    {
      id: "version",
      header: t("integrations.col.version"),
      width: "88px",
      tier: 3,
      cell: (integration) => (
        <span className="text-muted-foreground truncate font-mono text-xs">
          {integration.manifest.version ?? "—"}
        </span>
      ),
    },
  ];
}
