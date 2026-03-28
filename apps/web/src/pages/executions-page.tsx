import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { PlayCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useFlows } from "../hooks/use-packages";
import { useUnreadCount, useAllExecutions, useMarkAllRead } from "../hooks/use-notifications";
import { PageHeader } from "../components/page-header";
import { LoadingState, ErrorState, EmptyState } from "../components/page-states";
import { ExecutionRow } from "../components/execution-row";
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

  const executions = data?.executions ?? [];
  const total = data?.total ?? 0;
  const hasMore = (page + 1) * limit < total;

  if (isLoading && page === 0) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  return (
    <>
      <PageHeader
        title={t("executions.title")}
        emoji="▶️"
        breadcrumbs={[{ label: t("nav.orgSection", { ns: "common" }), href: "/" }, { label: t("executions.title") }]}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => markAllRead.mutate()}
            disabled={markAllRead.isPending || !unreadCount}
          >
            {t("executions.markAllRead")}
          </Button>
        }
      />

      {executions.length === 0 ? (
        <EmptyState
          message={t("executions.empty")}
          hint={t("executions.emptyHint")}
          icon={PlayCircle}
        >
          <Link to="/flows">
            <Button variant="outline">{t("executions.goToFlows")}</Button>
          </Link>
        </EmptyState>
      ) : (
        <>
          <div className="space-y-1">
            {executions.map((exec: Execution, index: number) => (
              <ExecutionRow
                key={exec.id}
                execution={exec}
                executionNumber={total - page * limit - index}
                flowName={flowNameMap.get(exec.packageId ?? "") ?? exec.packageId ?? "\u2014"}
              />
            ))}
          </div>

          {hasMore && (
            <Button variant="outline" className="w-full mt-4" onClick={() => setPage((p) => p + 1)}>
              {t("executions.loadMore")}
            </Button>
          )}
        </>
      )}
    </>
  );
}
