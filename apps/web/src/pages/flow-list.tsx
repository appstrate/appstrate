import { useState } from "react";
import { Link } from "react-router-dom";
import { useFlows } from "../hooks/use-flows";
import { useOrg } from "../hooks/use-org";
import { Spinner } from "../components/spinner";
import { ImportModal } from "../components/import-modal";
import { LoadingState, ErrorState } from "../components/page-states";

export function FlowList() {
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
                <button>Creer un flow</button>
              </Link>
            )}
            <button onClick={() => setImportOpen(true)}>Importer un flow</button>
          </div>
        </div>
        <div className="empty-state">
          <p>Aucun flow disponible.</p>
          <p className="empty-hint">
            Ajoutez un flow dans le repertoire <code>flows/</code> ou importez un ZIP
          </p>
        </div>
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
              <button>Creer un flow</button>
            </Link>
          )}
          <button onClick={() => setImportOpen(true)}>Importer un flow</button>
        </div>
      </div>
      <div className="flow-grid">
        {flows.map((flow) => (
          <Link key={flow.id} className="flow-card" to={`/flows/${flow.id}`}>
            <div className="flow-card-header">
              <h2>{flow.displayName}</h2>
              <div className="flow-card-badges">
                {flow.source === "user" && <span className="source-badge">Utilisateur</span>}
                {flow.runningExecutions > 0 && (
                  <span className="running-badge">
                    <Spinner /> {flow.runningExecutions} en cours
                  </span>
                )}
              </div>
            </div>
            <p className="description">{flow.description}</p>
            <div className="tags">
              {(flow.tags || []).map((t) => (
                <span key={t} className="tag">
                  {t}
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
