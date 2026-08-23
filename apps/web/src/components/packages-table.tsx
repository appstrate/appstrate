// SPDX-License-Identifier: Apache-2.0

/**
 * The packages column set (`dt-agents` in the reference) — agents, skills and
 * MCP servers, which are the same catalogue rendered three times.
 *
 * The reference keeps CARDS for this family and offers the table beside them
 * (`view-toggle`), and it is right to: a card carries a description at a length
 * you can actually read, which is what you need when you are choosing an agent
 * rather than scanning a run. The table is for the other moment — twenty of
 * them, and you want to know which ones are system, which are running, and at
 * what version, in one glance down a column.
 *
 * It reads the same {@link CardItem} the cards do, so a screen switches views
 * without either side knowing anything the other does not.
 */

import { useTranslation } from "react-i18next";
import { ShieldCheck } from "lucide-react";
import type { CollectionState } from "./collection";
import { DataTable, type DataColumn } from "./data-table";
import { Badge, MetaBadge } from "./status-badge";
import { RunAgentButton } from "./run-agent-button";
import { packageDetailPath } from "../lib/package-paths";
import type { CardItem } from "../pages/package-list";
import type { PackageType } from "@appstrate/core/validation";

/** The column set, as a value the caller holds — see `useRunColumns` on why. */
/**
 * @param holds What the list contains. Only an AGENT can be running or be run,
 * so on any other list the `state` column is a column of em dashes and the
 * actions column is empty — which is what the skills and MCP-server tables have
 * been drawing all along, and what the integrations table would have inherited.
 * A column that can never say anything is not a column.
 */
export function usePackageColumns(holds?: PackageType): DataColumn<CardItem>[] {
  const { t } = useTranslation(["agents", "common"]);
  const runnable = holds === undefined || holds === "agent";

  const columns: DataColumn<CardItem>[] = [
    {
      id: "name",
      header: t("list.column.name"),
      width: "minmax(188px,1.6fr)",
      cell: (item) => (
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
      ),
    },
    {
      id: "source",
      header: t("list.column.source"),
      width: "112px",
      tier: 2,
      cell: (item) => (
        <>
          {item.source === "system" && (
            <span
              className="text-muted-foreground relative z-10 inline-flex items-center gap-1 text-xs"
              title={t("list.badgeBuiltIn")}
            >
              <ShieldCheck className="size-3.5 shrink-0" />
              {t("list.badgeBuiltIn")}
            </span>
          )}
          {item.autoInstalled && <MetaBadge label={t("list.badgeAutoInstalled")} />}
        </>
      ),
    },
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
      // flight and an em dash the rest of the time, so at tier one it was a
      // column of dashes taking 104px from the two things a phone needs here:
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

export function PackagesTable({
  items,
  columns,
  ...state
}: {
  items: CardItem[];
  /** From {@link usePackageColumns}, minus whatever the reader hid. */
  columns: DataColumn<CardItem>[];
} & CollectionState) {
  const { t } = useTranslation(["agents", "common"]);

  // The same state `CardGrid` takes, forwarded whole: the two bodies answer it
  // through the same `collectionVerdict`, so a caller can hand either one the
  // same props and branch on nothing.
  return (
    <DataTable
      label={t("list.tableLabel")}
      columns={columns}
      rows={items}
      rowKey={(item) => item.id}
      rowHref={(item) => packageDetailPath(item.type, item.id)}
      rowLabel={(item) => item.displayName}
      {...state}
    />
  );
}
