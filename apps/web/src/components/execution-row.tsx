import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Shield } from "lucide-react";
import { Badge } from "./badge";
import { Badge as UIBadge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatDateField, truncate } from "../lib/markdown";
import type { Execution } from "@appstrate/shared-types";

export function ExecutionRow({
  execution,
  executionNumber,
  flowName,
  userName,
}: {
  execution: Execution;
  executionNumber?: number;
  flowName?: string;
  userName?: string;
}) {
  const { t } = useTranslation(["flows"]);
  const isRunning = execution.status === "running" || execution.status === "pending";
  const isUnread = execution.notifiedAt != null && execution.readAt == null;
  const date = execution.startedAt ? formatDateField(execution.startedAt) : "";
  const inputPreview = execution.input ? truncate(JSON.stringify(execution.input), 60) : "";

  // Live elapsed timer while running
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!isRunning || !execution.startedAt) return;
    const start = new Date(execution.startedAt).getTime();
    const tick = () => setElapsed(Date.now() - start);
    tick();
    const id = setInterval(tick, 100);
    return () => clearInterval(id);
  }, [isRunning, execution.startedAt]);

  const time = isRunning ? elapsed : execution.duration;
  const duration = time ? `${(time / 1000).toFixed(1)}s` : "";

  return (
    <Link
      className={cn(
        "flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted/50 transition-colors",
        isUnread && "border-l-2 border-l-primary",
      )}
      to={`/flows/${execution.packageId}/executions/${execution.id}`}
      state={{ executionNumber }}
    >
      <div className="flex flex-1 items-center gap-2 min-w-0">
        {executionNumber != null && (
          <span className="text-muted-foreground font-mono text-xs">#{executionNumber}</span>
        )}
        {flowName && <span className="font-medium truncate max-w-[150px]">{flowName}</span>}
        <Badge status={execution.status} />
        {userName && (
          <span className="text-muted-foreground text-xs">
            {t("exec.user", { name: userName })}
          </span>
        )}
        <span className="text-muted-foreground text-xs">{date}</span>
        {duration && <span className="text-muted-foreground text-xs font-mono">{duration}</span>}
        {execution.tokensUsed != null && (
          <span className="text-muted-foreground text-xs">
            {execution.tokensUsed.toLocaleString()} tok
          </span>
        )}
        {inputPreview && (
          <span className="text-muted-foreground text-xs truncate max-w-[200px]">
            {inputPreview}
          </span>
        )}
        <UIBadge variant={execution.packageVersion ? "outline" : "secondary"}>
          {execution.packageVersion ? `v${execution.packageVersion}` : t("exec.draft")}
        </UIBadge>
        {execution.proxyLabel && <Shield size={12} className="text-muted-foreground" />}
        {execution.scheduleId && <UIBadge variant="secondary">cron</UIBadge>}
      </div>
    </Link>
  );
}
