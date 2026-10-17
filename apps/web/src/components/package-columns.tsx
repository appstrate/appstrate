// SPDX-License-Identifier: Apache-2.0

/**
 * The packages column set — agents, skills and MCP servers, which are the
 * same catalogue rendered three times.
 *
 * The index pages draw cards; the table serves the catalogue's management view and the
 * "used by" panel, where you scan twenty packages down a column. It reads the same
 * {@link CardItem} the cards do.
 */

import { useTranslation } from "react-i18next";
import type { PackageType } from "@appstrate/core/validation";
import type { DataColumn } from "./data-table";
import { RunStatusBadge } from "./status-badge";
import { RunAgentButton } from "./run-agent-button";
import { PackageIcon } from "./package-icon";
import { useCatalogueOriginColumn } from "./catalogue-columns";
import { CountBadge } from "./count-badge";
import { rowActionsColumn } from "./row-actions-column";
import { CellEmpty, CellText } from "./table-cells";
import { useOrg } from "../hooks/use-org";
import type { CardItem } from "../lib/package-card-item";

/** The package identity shared by the index, usage and catalogue tables. */
export function usePackageNameColumn(): DataColumn<CardItem> {
  const { t } = useTranslation(["agents", "common"]);
  return {
    id: "name",
    header: t("list.column.name"),
    width: 188,
    elastic: true,
    cell: (item) => (
      <div className="flex min-w-0 items-center gap-3">
        {item.identity && (
          <PackageIcon
            type="agent"
            icon={item.identity.icon}
            color={item.identity.color}
            className="size-8 rounded-md"
            iconClassName="size-4"
          />
        )}
        {item.type === "integration" && (
          <PackageIcon type="integration" icon={item.logo} size="sm" />
        )}
        <div className="flex min-w-0 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-medium">{item.displayName}</span>
            <CountBadge
              count={item.unreadCount ?? 0}
              label={t("dashboard.unreadRuns", { count: item.unreadCount ?? 0 })}
              className="relative z-10 shrink-0"
            />
          </span>
          {/* Second line: the description, else the id. When the name line already
              is the id (no display_name), a dash keeps the row height. */}
          {item.description ? (
            <CellText>{item.description}</CellText>
          ) : item.displayName !== item.id ? (
            <CellText mono title={item.id}>
              {item.id}
            </CellText>
          ) : (
            <CellText>
              <CellEmpty />
            </CellText>
          )}
        </div>
      </div>
    ),
  };
}

/** Only agents have a run state and a run action. */
export function usePackageColumns(holds: PackageType): DataColumn<CardItem>[] {
  const { t } = useTranslation(["agents", "common"]);
  const name = usePackageNameColumn();
  const runnable = holds === "agent";
  const origin = useCatalogueOriginColumn<CardItem>(useOrg().currentOrg?.name ?? "");
  const columns: DataColumn<CardItem>[] = [
    name,
    origin,
    {
      id: "keywords",
      header: t("manifest.keywords"),
      width: 140,
      elastic: true,
      tier: 3,
      cell: (item) => {
        const used =
          item.type !== "agent" && item.usedByAgents
            ? t("list.usedByAgents", { count: item.usedByAgents })
            : null;
        const labels = [...(item.keywords ?? []), ...(used ? [used] : [])];
        if (labels.length === 0) return <CellEmpty />;
        return <CellText title={labels.join(", ")}>{labels.join(" · ")}</CellText>;
      },
    },
    {
      id: "state",
      header: t("list.column.state"),
      width: 104,
      // Waits for a 36rem table. It carries a badge only while a run is in
      // flight and an em dash the rest of the time, so at tier one it would be
      // a column of dashes taking 104px from the two things a phone needs here:
      // which package this is, and the button that runs it.
      tier: 2,
      cell: (item) =>
        item.type === "agent" && !!item.runningRuns && item.runningRuns > 0 ? (
          <RunStatusBadge status="running" compact />
        ) : (
          <CellEmpty />
        ),
    },
    rowActionsColumn((item) =>
      item.type === "agent" ? (
        // Raised above the row's link overlay, or the row would swallow the
        // click and open the agent instead of running it.
        <span className="relative z-10">
          <RunAgentButton
            packageId={item.id}
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-primary size-7"
          />
        </span>
      ) : null,
    ),
  ];

  return runnable ? columns : columns.filter((c) => c.id !== "state" && c.id !== "actions");
}
