import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useFlowDetail } from "../hooks/use-flows";
import { useExecutions } from "../hooks/use-executions";
import { useRunFlow, useConnect } from "../hooks/use-mutations";
import { useWsChannel } from "../hooks/use-websocket";
import { Spinner } from "../components/spinner";
import { Badge } from "../components/badge";
import { ConfigModal } from "../components/config-modal";
import { StateModal } from "../components/state-modal";
import { InputModal } from "../components/input-modal";
import { truncate } from "../lib/markdown";

function checkRequiredConfig(detail: {
  config: { schema: Record<string, { required?: boolean }>; current: Record<string, unknown> };
}): boolean {
  const schema = detail.config?.schema || {};
  const current = detail.config?.current || {};
  for (const [key, field] of Object.entries(schema)) {
    if (
      field.required &&
      (current[key] === undefined || current[key] === null || current[key] === "")
    ) {
      return false;
    }
  }
  return true;
}

export function FlowDetailPage() {
  const { flowId } = useParams<{ flowId: string }>();
  const qc = useQueryClient();

  const { data: detail, isLoading, error } = useFlowDetail(flowId);
  const { data: executions } = useExecutions(flowId);
  const runFlow = useRunFlow(flowId!);
  const connectMutation = useConnect();

  const [configOpen, setConfigOpen] = useState(false);
  const [stateOpen, setStateOpen] = useState(false);
  const [inputOpen, setInputOpen] = useState(false);

  useWsChannel(flowId ? `flow:${flowId}` : null, () => {
    qc.invalidateQueries({ queryKey: ["executions", flowId] });
  });

  if (isLoading) {
    return (
      <div className="empty-state">
        <Spinner />
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="empty-state">
        <p>Impossible de charger le flow.</p>
        <p className="empty-hint">{error?.message}</p>
      </div>
    );
  }

  const allConnected = detail.requires.services.every((s) => s.status === "connected");
  const hasRequiredConfig = checkRequiredConfig(detail);
  const hasInputSchema = detail.input?.schema && Object.keys(detail.input.schema).length > 0;
  const hasState = detail.state && Object.keys(detail.state).length > 0;

  const handleRun = () => {
    if (hasInputSchema) {
      setInputOpen(true);
    } else {
      runFlow.mutate(undefined);
    }
  };

  return (
    <>
      <nav className="breadcrumb">
        <Link to="/">Flows</Link>
        <span className="separator">/</span>
        <span className="current">{detail.displayName}</span>
      </nav>

      <div className="flow-detail-header">
        <h2>{detail.displayName}</h2>
        <p className="description">{detail.description}</p>
      </div>

      <div className="services">
        {detail.requires.services.map((svc) => {
          const isConnected = svc.status === "connected";
          return (
            <button
              key={svc.id}
              type="button"
              className={`service ${isConnected ? "" : "not-connected"}`}
              onClick={!isConnected ? () => connectMutation.mutate(svc.provider) : undefined}
              disabled={isConnected}
              title={svc.description}
            >
              <span className={`status-dot ${isConnected ? "connected" : "disconnected"}`} />
              {svc.id}
              {!isConnected && " (connecter)"}
            </button>
          );
        })}
      </div>

      <div className="actions">
        <button onClick={() => setConfigOpen(true)}>Configurer</button>
        {hasState ? (
          <button onClick={() => setStateOpen(true)}>Etat</button>
        ) : (
          <button disabled title="Aucun etat persiste">
            Etat (vide)
          </button>
        )}
        <button
          className="primary"
          onClick={handleRun}
          disabled={!allConnected || !hasRequiredConfig || runFlow.isPending}
          title={
            !allConnected
              ? "Connectez tous les services d'abord"
              : !hasRequiredConfig
                ? "Configurez les champs obligatoires"
                : "Lancer le flow"
          }
        >
          Lancer
        </button>
      </div>

      <div className="section-title">Executions</div>
      {!executions || executions.length === 0 ? (
        <div className="empty-state empty-state-compact">
          <p className="empty-hint">Aucune execution</p>
        </div>
      ) : (
        <div className="exec-list">
          {executions.map((exec) => {
            const date = new Date(exec.started_at).toLocaleString("fr-FR", {
              day: "2-digit",
              month: "2-digit",
              year: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            });
            const duration = exec.duration ? `${(exec.duration / 1000).toFixed(1)}s` : "";
            const inputPreview = exec.input ? truncate(JSON.stringify(exec.input), 60) : "";

            return (
              <Link
                key={exec.id}
                className="exec-row"
                to={`/flows/${flowId}/executions/${exec.id}`}
              >
                <Badge status={exec.status} />
                <span className="exec-date">{date}</span>
                {duration && <span className="exec-duration">{duration}</span>}
                {inputPreview && <span className="exec-input-preview">{inputPreview}</span>}
              </Link>
            );
          })}
        </div>
      )}

      <ConfigModal open={configOpen} onClose={() => setConfigOpen(false)} flow={detail} />
      <StateModal open={stateOpen} onClose={() => setStateOpen(false)} flow={detail} />
      <InputModal
        open={inputOpen}
        onClose={() => setInputOpen(false)}
        flow={detail}
        onSubmit={(input) => runFlow.mutate(input)}
      />
    </>
  );
}
