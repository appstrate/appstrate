// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import type { IntegrationIndexItem } from "@appstrate/shared-types";
import type { DataColumn } from "../components/data-table";
import { PackageIcon } from "../components/package-icon";
import {
  useCatalogueOriginColumn,
  useCatalogueProtocolColumn,
} from "../components/catalogue-columns";
import { useOrg } from "../hooks/use-org";
import { integrationProtocol } from "../lib/integration-collection";

/** One comparable integration fact per column. */
export function useIntegrationListColumns(): DataColumn<IntegrationIndexItem>[] {
  const { t } = useTranslation("settings");
  const origin = useCatalogueOriginColumn<IntegrationIndexItem>(useOrg().currentOrg?.name ?? "");
  // Remote tab only: API or MCP.
  const protocol = useCatalogueProtocolColumn<IntegrationIndexItem>((integration) =>
    integrationProtocol(integration.source_kind),
  );

  return [
    {
      id: "name",
      header: t("integrations.col.name"),
      width: 132,
      elastic: true,
      cell: (integration) => (
        <div className="flex min-w-0 items-center gap-2">
          <PackageIcon type="integration" icon={integration.icon} size="sm" />
          <span className="truncate font-medium">{integration.name}</span>
        </div>
      ),
    },
    origin,
    protocol,
    {
      // Local tab only: the server package the sandbox runs.
      id: "server",
      header: t("integrations.col.server"),
      width: 140,
      elastic: true,
      tier: 3,
      cell: ({ server }) => (
        <span className="text-muted-foreground truncate font-mono text-xs">
          {server ? `${server.name} ${server.version}` : "—"}
        </span>
      ),
    },
    {
      id: "version",
      header: t("integrations.col.version"),
      width: 88,
      tier: 3,
      cell: (integration) => (
        <span className="text-muted-foreground truncate font-mono text-xs">
          {integration.version ?? "—"}
        </span>
      ),
    },
  ];
}
