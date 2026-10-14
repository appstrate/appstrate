// SPDX-License-Identifier: Apache-2.0

/**
 * The packages column set — agents, skills and MCP servers, which are the
 * same catalogue rendered three times.
 *
 * CARDS stay the default for this family, with the table beside them
 * (`view-toggle`): a card carries a description at a length you can actually
 * read, which is what you need when you are choosing an agent rather than
 * scanning a run. The table is for the other moment — twenty of them, and you
 * want to know which ones are system, which are running, and at what version,
 * in one glance down a column.
 *
 * It reads the same {@link CardItem} the cards do, so a screen switches views
 * without either side knowing anything the other does not.
 */

import { useTranslation } from "react-i18next";
import type { PackageType } from "@appstrate/core/validation";
import type { DataColumn } from "./data-table";
import { Badge } from "./status-badge";
import { RunAgentButton } from "./run-agent-button";
import { AgentIdentityTile } from "./agent-identity";
import { IntegrationIcon } from "./integration-icon";
import { useCatalogueOriginColumn } from "./catalogue-columns";
import { useOrg } from "../hooks/use-org";
import type { CardItem } from "../pages/package-list";

/**
 * The column set, as a value the caller holds — see `useRunColumns` on why.
 *
 * @param holds What the list contains. Only an AGENT can be running or be run,
 * so on any other list the `state` column would be a column of em dashes and
 * the actions column empty: they are left out. A column that can never say
 * anything is not a column.
 */
export function usePackageColumns(holds: PackageType): DataColumn<CardItem>[] {
  const { t } = useTranslation(["agents", "common"]);
  const runnable = holds === "agent";
  const origin = useCatalogueOriginColumn<CardItem>(useOrg().currentOrg?.name ?? "");

  const columns: DataColumn<CardItem>[] = [
    {
      id: "name",
      header: t("list.column.name"),
      width: "minmax(188px,1.6fr)",
      cell: (item) => (
        <div className="flex min-w-0 items-center gap-3">
          {item.identity && (
            <AgentIdentityTile
              agentId={item.id}
              icon={item.identity.icon}
              color={item.identity.color}
              className="size-8 rounded-md"
              iconClassName="size-4"
            />
          )}
          {item.type === "integration" && <IntegrationIcon src={item.logo} size="sm" />}
          <div className="flex min-w-0 flex-col">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate font-medium">{item.displayName}</span>
              {!!item.unreadCount && item.unreadCount > 0 && (
                <span className="bg-destructive text-destructive-foreground relative z-10 flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full px-1 text-[0.6rem] leading-none font-medium">
                  {item.unreadCount > 99 ? "99+" : item.unreadCount}
                </span>
              )}
            </span>
            {/* One line, where the card gives two: at this density a description
                is there to tell two neighbours apart, not to be read. */}
            {item.description && (
              <span className="text-muted-foreground truncate text-xs">{item.description}</span>
            )}
          </div>
        </div>
      ),
    },
    origin,
    {
      id: "keywords",
      header: t("list.column.keywords"),
      width: "minmax(140px,1fr)",
      tier: 3,
      cell: (item) => {
        const used =
          item.type !== "agent" && item.usedByAgents
            ? t("list.usedByAgents", { count: item.usedByAgents })
            : null;
        const labels = [...(item.keywords ?? []), ...(used ? [used] : [])];
        if (labels.length === 0) return <span className="text-muted-foreground/50">—</span>;
        return (
          <span className="text-muted-foreground truncate text-xs" title={labels.join(", ")}>
            {labels.join(" · ")}
          </span>
        );
      },
    },
    {
      id: "state",
      header: t("list.column.state"),
      width: "104px",
      // Waits for a 36rem table. It carries a badge only while a run is in
      // flight and an em dash the rest of the time, so at tier one it would be
      // a column of dashes taking 104px from the two things a phone needs here:
      // which package this is, and the button that runs it.
      tier: 2,
      cell: (item) =>
        item.type === "agent" && !!item.runningRuns && item.runningRuns > 0 ? (
          <Badge status="running" compact />
        ) : (
          <span className="text-muted-foreground/50">—</span>
        ),
    },
    {
      id: "actions",
      header: "",
      width: "48px",
      align: "end",
      cell: (item) =>
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
    },
  ];

  return runnable ? columns : columns.filter((c) => c.id !== "state" && c.id !== "actions");
}
