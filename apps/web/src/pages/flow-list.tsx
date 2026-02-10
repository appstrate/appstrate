import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useFlows } from "../hooks/use-flows";
import { useWsChannel } from "../hooks/use-websocket";
import { Spinner } from "../components/spinner";

export function FlowList() {
  const qc = useQueryClient();
  const { data: flows, isLoading, error } = useFlows();

  useWsChannel("flows", () => {
    qc.invalidateQueries({ queryKey: ["flows"] });
  });

  if (isLoading) {
    return (
      <div className="empty-state">
        <Spinner />
      </div>
    );
  }

  if (error) {
    return (
      <div className="empty-state">
        <p>Impossible de charger les flows.</p>
        <p className="empty-hint">{error.message}</p>
      </div>
    );
  }

  if (!flows || flows.length === 0) {
    return (
      <div className="empty-state">
        <p>Aucun flow disponible.</p>
        <p className="empty-hint">
          Ajoutez un flow dans le repertoire <code>flows/</code>
        </p>
      </div>
    );
  }

  return (
    <div className="flow-grid">
      {flows.map((flow) => (
        <Link key={flow.id} className="flow-card" to={`/flows/${flow.id}`}>
          <div className="flow-card-header">
            <h2>{flow.displayName}</h2>
            {flow.runningExecutions > 0 && (
              <span className="running-badge">
                <Spinner /> {flow.runningExecutions} en cours
              </span>
            )}
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
  );
}
