// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import type { IntegrationIndexItem } from "@appstrate/shared-types";
import type { DataColumn } from "../components/data-table";
import { PackageIcon } from "../components/package-icon";
import { useSpaceColumn } from "../components/space-column";
import {
  useCatalogueOriginColumn,
  useCatalogueProtocolColumn,
} from "../components/catalogue-columns";
import { useOrg } from "../hooks/use-org";
import { integrationProtocol } from "../lib/integration-collection";

/**
 * One comparable integration fact per column. `connectionCount` is the caller's own connections
 * of an integration in a row's space (`useConnectionCounts`); `undefined` while unknown, drawn as
 * « — ». `spanning`: an index across spaces, each row naming its space.
 */
export function useIntegrationListColumns(
  connectionCount: ((sourceId: string, spaceId: string) => number) | undefined,
  spanning: boolean,
): DataColumn<IntegrationIndexItem>[] {
  const { t } = useTranslation("settings");
  const spaceColumn = useSpaceColumn<IntegrationIndexItem>(spanning);
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
    ...spaceColumn,
    origin,
    protocol,
    {
      // Local tab only: the server package the sandbox runs.
      id: "server",
      header: t("integrations.col.server"),
      width: 140,
      elastic: true,
      cell: ({ server }) => (
        <span className="text-muted-foreground truncate font-mono text-xs">
          {server ? `${server.name} ${server.version}` : "—"}
        </span>
      ),
    },
    {
      id: "connections",
      header: t("integrations.col.connections"),
      width: 112,
      align: "end",
      cell: (integration) => {
        const count = connectionCount?.(integration.id, integration.spaceId);
        return (
          <span className={count ? "tabular-nums" : "text-muted-foreground tabular-nums"}>
            {count ?? "—"}
          </span>
        );
      },
    },
    {
      id: "version",
      header: t("integrations.col.version"),
      width: 88,
      cell: (integration) => (
        <span className="text-muted-foreground truncate font-mono text-xs">
          {integration.version ?? "—"}
        </span>
      ),
    },
  ];
}
