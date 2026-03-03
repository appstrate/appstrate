import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Badge } from "./badge";
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

  const resultPreview =
    execution.status === "success" && execution.result
      ? truncate(JSON.stringify(execution.result), 80)
      : "";

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
      className={`exec-row${isUnread ? " unread" : ""}`}
      to={`/flows/${execution.packageId}/executions/${execution.id}`}
      state={{ executionNumber }}
    >
      <div className="exec-row-main">
        {executionNumber != null && <span className="exec-number">#{executionNumber}</span>}
        {flowName && <span className="exec-flow-name">{flowName}</span>}
        <Badge status={execution.status} />
        {userName && <span className="exec-user">{t("exec.user", { name: userName })}</span>}
        <span className="exec-date">{date}</span>
        {duration && <span className="exec-duration">{duration}</span>}
        {execution.tokensUsed != null && (
          <span className="exec-tokens">{execution.tokensUsed.toLocaleString()} tok</span>
        )}
        {inputPreview && <span className="exec-input-preview">{inputPreview}</span>}
        {execution.packageVersion && <span className="tag">v{execution.packageVersion}</span>}
        {execution.scheduleId && <span className="tag">cron</span>}
      </div>
      {resultPreview && (
        <div className="exec-result-preview">
          {t("exec.resultLabel")} {resultPreview}
        </div>
      )}
    </Link>
  );
}
