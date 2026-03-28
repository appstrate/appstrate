import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { PackageType } from "@appstrate/shared-types";
import { ShieldCheck } from "lucide-react";
import { Badge } from "./badge";
import { RunFlowButton } from "./run-flow-button";
import { ProviderIcon } from "./provider-icon";
import { packageDetailPath } from "../lib/package-paths";

interface PackageCardProps {
  id: string;
  displayName: string;
  description?: string | null;
  type: PackageType;
  source?: "system" | "local";
  runningExecutions?: number;
  keywords?: string[];
  usedByFlows?: number;
  unreadCount?: number;
  statusBadge?: React.ReactNode;
  actions?: React.ReactNode;
  iconUrl?: string;
  autoInstalled?: boolean;
}

export function PackageCard({
  id,
  displayName,
  description,
  type,
  source,
  runningExecutions,
  keywords,
  usedByFlows,
  unreadCount,
  statusBadge,
  actions,
  iconUrl,
  autoInstalled,
}: PackageCardProps) {
  const { t } = useTranslation(["flows", "settings", "common"]);
  const href = packageDetailPath(type, id);

  return (
    <Link
      className="flex flex-col w-full rounded-lg border border-border bg-card p-4 transition-colors hover:border-foreground/20 hover:bg-accent/50 h-full"
      to={href}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {iconUrl && <ProviderIcon src={iconUrl} className="h-5 w-5" />}
          <h2 className="text-sm font-medium text-foreground truncate">{displayName}</h2>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {source === "system" && (
            <span title={t("list.badgeBuiltIn")}>
              <ShieldCheck className="h-4 w-4 text-muted-foreground" />
            </span>
          )}
          {autoInstalled && (
            <span className="text-[0.65rem] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-medium uppercase">
              {t("list.badgeAutoInstalled")}
            </span>
          )}
          {statusBadge}
          {!!unreadCount && unreadCount > 0 && (
            <span className="flex items-center justify-center min-w-4 h-4 px-1 rounded-full bg-destructive text-destructive-foreground text-[0.6rem] font-medium leading-none">
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
          {type === "flow" && !!runningExecutions && runningExecutions > 0 && (
            <Badge status="running" />
          )}
          {type === "flow" && (
            <div
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
            >
              <RunFlowButton
                packageId={id}
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground hover:text-primary"
              />
            </div>
          )}
        </div>
      </div>
      <p className="mt-1 text-xs text-muted-foreground line-clamp-2 flex-1">{description || ""}</p>
      <div className="mt-2 flex flex-wrap gap-1">
        {keywords?.map((kw) => (
          <span
            key={kw}
            className="text-[0.7rem] px-2 py-0.5 rounded-full bg-background text-muted-foreground border border-border"
          >
            {kw}
          </span>
        ))}
        {type !== "flow" && usedByFlows !== undefined && usedByFlows > 0 && (
          <span className="text-[0.7rem] px-2 py-0.5 rounded-full bg-background text-muted-foreground border border-border">
            {t("list.usedByFlows", { count: usedByFlows, ns: "flows" })}
          </span>
        )}
      </div>
      {actions && (
        <div
          className="mt-3 pt-3 border-t border-border flex items-center justify-between gap-2"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          {actions}
        </div>
      )}
    </Link>
  );
}
