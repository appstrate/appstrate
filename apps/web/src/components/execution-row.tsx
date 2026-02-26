import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Badge } from "./badge";
import { formatDateField, truncate } from "../lib/markdown";
import type { Execution } from "@appstrate/shared-types";

export function ExecutionRow({
  execution,
  flowName,
  userName,
}: {
  execution: Execution;
  flowName?: string;
  userName?: string;
}) {
  const { t } = useTranslation(["flows"]);
  const isUnread = execution.notifiedAt != null && execution.readAt == null;
  const date = execution.startedAt ? formatDateField(execution.startedAt) : "";
  const duration = execution.duration ? `${(execution.duration / 1000).toFixed(1)}s` : "";
  const inputPreview = execution.input ? truncate(JSON.stringify(execution.input), 60) : "";

  return (
    <Link
      className={`exec-row${isUnread ? " unread" : ""}`}
      to={`/flows/${execution.flowId}/executions/${execution.id}`}
    >
      {flowName && <span className="exec-flow-name">{flowName}</span>}
      <Badge status={execution.status} />
      {userName && <span className="exec-user">{t("exec.user", { name: userName })}</span>}
      <span className="exec-date">{date}</span>
      {duration && <span className="exec-duration">{duration}</span>}
      {execution.tokensUsed != null && (
        <span className="exec-tokens">{execution.tokensUsed.toLocaleString()} tok</span>
      )}
      {inputPreview && <span className="exec-input-preview">{inputPreview}</span>}
      {execution.scheduleId && <span className="tag">cron</span>}
    </Link>
  );
}
