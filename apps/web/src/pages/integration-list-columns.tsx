// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Settings2 } from "lucide-react";
import { Badge } from "@appstrate/ui/components/badge";
import type { DataColumn } from "../components/data-table";
import { IntegrationIcon } from "../components/integration-icon";
import { TableRowActions } from "../components/table-row-actions";
import type { IntegrationSummaryWire } from "../hooks/use-integrations";
import { integrationOrigin, integrationStatus } from "../lib/integration-collection";

/** One comparable integration fact per column. */
export function useIntegrationListColumns({
  onOpen,
}: {
  onOpen: (integration: IntegrationSummaryWire) => void;
}): DataColumn<IntegrationSummaryWire>[] {
  const { t } = useTranslation("settings");

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
    {
      id: "origin",
      header: t("integrations.col.origin"),
      width: "104px",
      tier: 2,
      cell: (integration) => (
        <span className="text-muted-foreground text-xs">
          {t(
            integrationOrigin(integration) === "system"
              ? "integrations.origin.system"
              : "integrations.origin.custom",
          )}
        </span>
      ),
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
    {
      id: "status",
      header: t("integrations.col.status"),
      width: "96px",
      tier: 2,
      cell: (integration) => (
        <Badge variant={integration.active ? "success" : "secondary"}>
          {t(
            integrationStatus(integration) === "active"
              ? "integrations.badge.active"
              : "integrations.badge.inactive",
          )}
        </Badge>
      ),
    },
    {
      id: "actions",
      header: "",
      width: "48px",
      align: "end",
      cell: (integration) => (
        <TableRowActions
          primary={{
            label: t("integrations.open", {
              name: integration.manifest.display_name ?? integration.id,
            }),
            icon: Settings2,
            onSelect: () => onOpen(integration),
          }}
        />
      ),
    },
  ];
}
