// SPDX-License-Identifier: Apache-2.0

/**
 * The webhooks column set.
 *
 * A webhook row is a record — where it posts, on which events, for which agent,
 * in which payload mode, on or off — so it belongs in a table rather than in a
 * card that reprints those five labels on every row.
 *
 * The row is a LINK to the webhook's own page, which is what makes the table
 * legal here: a row leads somewhere, and `DataTable` stretches the link over it
 * so middle-click and ⌘-click keep working.
 */

import { useTranslation } from "react-i18next";
import { Badge } from "@appstrate/ui/components/badge";
import type { DataColumn } from "@/components/data-table";
import type { components } from "@/api/schema";

type Webhook = components["schemas"]["WebhookObject"];

export function useWebhookColumns(): DataColumn<Webhook>[] {
  const { t } = useTranslation(["settings", "common"]);

  return [
    {
      id: "endpoint",
      header: t("settings:webhooks.urlColumn"),
      width: "minmax(100px,2fr)",
      cell: (wh) => (
        <span className="truncate font-mono text-xs" title={wh.url}>
          {wh.url}
        </span>
      ),
    },
    {
      id: "state",
      header: t("settings:webhooks.stateColumn"),
      width: "72px",
      cell: (wh) => (
        <Badge variant={wh.enabled ? "success" : "secondary"}>
          {wh.enabled ? t("settings:webhooks.active") : t("settings:webhooks.inactive")}
        </Badge>
      ),
    },
    {
      id: "events",
      header: t("settings:webhooks.eventsColumn"),
      width: "minmax(100px,1.4fr)",
      // Tier 2, not 3: this list is a full page, but it is also reachable in
      // the settings dialog, which never crosses the 56rem threshold.
      tier: 2,
      cell: (wh) => (
        <span
          className="text-muted-foreground truncate font-mono text-xs"
          title={wh.events.join(", ")}
        >
          {wh.events.join(", ")}
        </span>
      ),
    },
    {
      id: "agent",
      header: t("settings:webhooks.agentColumn"),
      width: "minmax(80px,1fr)",
      tier: 2,
      cell: (wh) => (
        <span className="text-muted-foreground block truncate text-xs">
          {wh.packageId || t("settings:webhooks.allAgents")}
        </span>
      ),
    },
    {
      id: "payload",
      header: t("settings:webhooks.payloadColumn"),
      width: "72px",
      tier: 2,
      cell: (wh) => (
        <span className="text-muted-foreground block truncate text-xs">
          {wh.payloadMode === "full"
            ? t("settings:webhooks.payloadModeFull")
            : t("settings:webhooks.payloadModeSummary")}
        </span>
      ),
    },
  ];
}
