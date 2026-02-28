import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { PlayCircle } from "lucide-react";
import { useFlows } from "../hooks/use-flows";
import { useUnreadCount, useAllExecutions, useMarkAllRead } from "../hooks/use-notifications";
import { ExecutionRow } from "../components/execution-row";
import { LoadingState, ErrorState, EmptyState } from "../components/page-states";
import type { Execution } from "@appstrate/shared-types";

export function ExecutionsPage() {
  const { t } = useTranslation(["flows", "common"]);
  const [page, setPage] = useState(0);
  const limit = 20;
  const { data, isLoading, error } = useAllExecutions(page, limit);
  const { data: flows } = useFlows();
  const { data: unreadCount } = useUnreadCount();
  const markAllRead = useMarkAllRead();

  const flowNameMap = new Map<string, string>();
  if (flows) {
    for (const f of flows) {
      flowNameMap.set(f.id, f.displayName);
    }
  }

  if (isLoading && page === 0) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  const executions = data?.executions ?? [];
  const total = data?.total ?? 0;
  const hasMore = (page + 1) * limit < total;

  return (
    <>
      <div className="section-header">
        <div className="section-title">{t("executions.title")}</div>
        <button
          onClick={() => markAllRead.mutate()}
          disabled={markAllRead.isPending || !unreadCount}
        >
          {t("executions.markAllRead")}
        </button>
      </div>

      {executions.length === 0 ? (
        <EmptyState
          message={t("executions.empty")}
          hint={t("executions.emptyHint")}
          icon={PlayCircle}
        >
          <Link to="/">
            <button>{t("executions.goToFlows")}</button>
          </Link>
        </EmptyState>
      ) : (
        <div className="exec-list">
          {executions.map((exec: Execution, index: number) => (
            <ExecutionRow
              key={exec.id}
              execution={exec}
              executionNumber={total - page * limit - index}
              flowName={flowNameMap.get(exec.flowId) ?? exec.flowId}
            />
          ))}

          {hasMore && (
            <button className="load-more-btn" onClick={() => setPage((p) => p + 1)}>
              {t("executions.loadMore")}
            </button>
          )}
        </div>
      )}
    </>
  );
}
