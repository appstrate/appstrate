// SPDX-License-Identifier: Apache-2.0

import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { PackageType } from "@appstrate/core/validation";
import { ShieldCheck, Layers, Wrench, Plug, Boxes, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "./status-badge";
import { RunAgentButton } from "./run-agent-button";
import { packageDetailPath } from "../lib/package-paths";

interface PackageCardProps {
  id: string;
  displayName: string;
  description?: string | null;
  type: PackageType;
  source?: "system" | "local";
  runningRuns?: number;
  keywords?: string[];
  usedByAgents?: number;
  unreadCount?: number;
  actions?: React.ReactNode;
  autoInstalled?: boolean;
}

const TINTS = [
  "bg-primary-soft text-primary",
  "bg-spark-soft text-spark",
  "bg-success-soft text-success",
  "bg-warning-soft text-warning",
];

const TYPE_ICON: Record<PackageType, LucideIcon> = {
  agent: Layers,
  skill: Wrench,
  "mcp-server": Plug,
  integration: Boxes,
};

function tintFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return TINTS[h % TINTS.length]!;
}

export function PackageCard({
  id,
  displayName,
  description,
  type,
  source,
  runningRuns,
  keywords,
  usedByAgents,
  unreadCount,
  actions,
  autoInstalled,
}: PackageCardProps) {
  const { t } = useTranslation(["agents", "settings", "common"]);
  const href = packageDetailPath(type, id);
  const navigate = useNavigate();
  const Icon = TYPE_ICON[type];

  const handleCardClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (window.getSelection()?.toString()) return;
    if (e.metaKey || e.ctrlKey) {
      window.open(href, "_blank");
    } else {
      navigate(href);
    }
  };

  return (
    <div
      className="border-border bg-card hover:border-foreground/20 flex h-full w-full cursor-pointer flex-col gap-2.5 rounded-[var(--radius)] border p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md"
      onClick={handleCardClick}
    >
      <div className="flex items-start justify-between gap-2">
        <span
          className={cn("flex size-[38px] shrink-0 items-center justify-center rounded-[9px]", tintFor(id))}
        >
          <Icon className="size-5" />
        </span>
        <div className="flex shrink-0 items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          {!!unreadCount && unreadCount > 0 && (
            <span className="bg-spark text-spark-foreground flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[0.62rem] leading-none font-semibold">
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
          {type === "agent" && !!runningRuns && runningRuns > 0 ? (
            <Badge status="running" />
          ) : type === "agent" ? (
            <RunAgentButton
              packageId={id}
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-primary size-7"
            />
          ) : null}
        </div>
      </div>

      <h3 className="flex flex-wrap items-center gap-1.5 text-[0.96rem] font-semibold">
        <span className="truncate">{displayName}</span>
        {source === "system" && (
          <span
            className="bg-muted text-muted-foreground inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[0.62rem] font-semibold"
            title={t("list.badgeBuiltIn")}
          >
            <ShieldCheck className="size-3" /> {t("packages.sourceBuiltIn", { ns: "settings", defaultValue: "système" })}
          </span>
        )}
        {autoInstalled && (
          <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[0.62rem] font-semibold uppercase">
            {t("list.badgeAutoInstalled")}
          </span>
        )}
      </h3>

      <p className="text-muted-foreground line-clamp-2 min-h-[2.5em] flex-1 text-[0.82rem] leading-relaxed">
        {description || ""}
      </p>

      <div className="flex flex-wrap items-center gap-1.5">
        {keywords?.slice(0, 4).map((kw) => (
          <span
            key={kw}
            className="bg-background text-muted-foreground border-border rounded-full border px-2 py-[0.16rem] text-[0.72rem] font-medium"
          >
            {kw}
          </span>
        ))}
        {type !== "agent" && usedByAgents !== undefined && usedByAgents > 0 && (
          <span className="bg-background text-muted-foreground border-border rounded-full border px-2 py-[0.16rem] text-[0.72rem] font-medium">
            {t("list.used_by_agents", { count: usedByAgents, ns: "agents" })}
          </span>
        )}
      </div>

      {actions && (
        <div
          className="border-border mt-1 flex items-center justify-between gap-2 border-t pt-3"
          onClick={(e) => e.stopPropagation()}
        >
          {actions}
        </div>
      )}
    </div>
  );
}
