// SPDX-License-Identifier: Apache-2.0

import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ShieldCheck } from "lucide-react";
import { Badge } from "./status-badge";
import { RunAgentButton } from "./run-agent-button";
import { packageDetailPath } from "../lib/package-paths";
import { ScrollArea, ScrollBar } from "./ui/scroll-area";
import type { CardItem } from "../pages/package-list";

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
}: CardItem) {
  const { t } = useTranslation(["agents", "settings", "common"]);
  const href = packageDetailPath(type, id);
  const navigate = useNavigate();

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
      className="border-border bg-card hover:border-foreground/20 hover:bg-accent/50 flex h-full w-full cursor-pointer flex-col rounded-lg border p-4 transition-colors"
      onClick={handleCardClick}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="text-foreground truncate text-sm font-medium">{displayName}</h2>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {source === "system" && (
            <span title={t("list.badgeBuiltIn")}>
              <ShieldCheck className="text-muted-foreground h-4 w-4" />
            </span>
          )}
          {autoInstalled && (
            <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[0.65rem] font-medium uppercase">
              {t("list.badgeAutoInstalled")}
            </span>
          )}
          {!!unreadCount && unreadCount > 0 && (
            <span className="bg-destructive text-destructive-foreground flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[0.6rem] leading-none font-medium">
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
          {type === "agent" && !!runningRuns && runningRuns > 0 && <Badge status="running" />}
          {type === "agent" && (
            <div onClick={(e) => e.stopPropagation()}>
              <RunAgentButton
                packageId={id}
                variant="ghost"
                size="icon"
                className="text-muted-foreground hover:text-primary size-7"
              />
            </div>
          )}
        </div>
      </div>
      <p className="text-muted-foreground mt-1 line-clamp-2 flex-1 text-xs">{description || ""}</p>
      <ScrollArea className="mt-2 w-full">
        <div className="flex gap-1">
          {keywords?.map((kw) => (
            <span
              key={kw}
              className="bg-background text-muted-foreground border-border shrink-0 rounded-full border px-2 py-0.5 text-[0.7rem]"
            >
              {kw}
            </span>
          ))}
          {type !== "agent" && usedByAgents !== undefined && usedByAgents > 0 && (
            <span className="bg-background text-muted-foreground border-border shrink-0 rounded-full border px-2 py-0.5 text-[0.7rem]">
              {t("list.used_by_agents", { count: usedByAgents, ns: "agents" })}
            </span>
          )}
        </div>
        <ScrollBar orientation="horizontal" className="h-0 opacity-0" />
      </ScrollArea>
      {actions && (
        <div
          className="border-border mt-3 flex items-center justify-between gap-2 border-t pt-3"
          onClick={(e) => e.stopPropagation()}
        >
          {actions}
        </div>
      )}
    </div>
  );
}
