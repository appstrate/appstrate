import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Layers } from "lucide-react";
import { useFlows } from "../hooks/use-flows";
import { useOrg } from "../hooks/use-org";
import { Spinner } from "../components/spinner";
import { ImportModal } from "../components/import-modal";
import { LoadingState, ErrorState, EmptyState } from "../components/page-states";

export function FlowList() {
  const { t } = useTranslation(["flows", "common"]);
  const { data: flows, isLoading, error } = useFlows();
  const { isOrgAdmin } = useOrg();
  const [importOpen, setImportOpen] = useState(false);

  if (isLoading) return <LoadingState />;

  if (error) return <ErrorState message={error.message} />;

  if (!flows || flows.length === 0) {
    return (
      <>
        <div className="flow-list-header">
          <div />
          <div className="flow-list-actions">
            {isOrgAdmin && (
              <Link to="/flows/new">
                <button>{t("list.create")}</button>
              </Link>
            )}
            <button onClick={() => setImportOpen(true)}>{t("list.import")}</button>
          </div>
        </div>
        <EmptyState message={t("list.empty")} hint={t("list.emptyHint")} icon={Layers}>
          {isOrgAdmin && (
            <Link to="/flows/new">
              <button>{t("list.create")}</button>
            </Link>
          )}
          <button onClick={() => setImportOpen(true)}>{t("list.import")}</button>
        </EmptyState>
        <ImportModal open={importOpen} onClose={() => setImportOpen(false)} />
      </>
    );
  }

  return (
    <>
      <div className="flow-list-header">
        <div />
        <div className="flow-list-actions">
          {isOrgAdmin && (
            <Link to="/flows/new">
              <button>{t("list.create")}</button>
            </Link>
          )}
          <button onClick={() => setImportOpen(true)}>{t("list.import")}</button>
        </div>
      </div>
      <div className="flow-grid">
        {flows.map((flow) => (
          <Link key={flow.id} className="flow-card" to={`/flows/${flow.id}`}>
            <div className="flow-card-header">
              <h2>{flow.displayName}</h2>
              <div className="flow-card-badges">
                {flow.source === "built-in" && (
                  <span className="source-badge">{t("list.badgeBuiltIn")}</span>
                )}
                {flow.source === "user" && (
                  <span className="source-badge">{t("list.badgeUser")}</span>
                )}
                {flow.runningExecutions > 0 && (
                  <span className="running-badge">
                    <Spinner /> {t("list.running", { count: flow.runningExecutions })}
                  </span>
                )}
              </div>
            </div>
            <p className="description">{flow.description}</p>
            <div className="tags">
              {(flow.tags || []).map((tag) => (
                <span key={tag} className="tag">
                  {tag}
                </span>
              ))}
            </div>
          </Link>
        ))}
      </div>
      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} />
    </>
  );
}
