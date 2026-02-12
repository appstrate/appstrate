import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useFlowDetail } from "../hooks/use-flows";
import { useExecutions } from "../hooks/use-executions";
import {
  useSchedules,
  useCreateSchedule,
  useUpdateSchedule,
  useDeleteSchedule,
} from "../hooks/use-schedules";
import { useRunFlow, useConnect, useDeleteFlow, useConnectApiKey } from "../hooks/use-mutations";
import { useFlowExecutionRealtime } from "../hooks/use-realtime";
import { Spinner } from "../components/spinner";
import { Badge } from "../components/badge";
import { ConfigModal } from "../components/config-modal";
import { StateModal } from "../components/state-modal";
import { InputModal } from "../components/input-modal";
import { ScheduleModal } from "../components/schedule-modal";
import { ScheduleRow } from "../components/schedule-row";
import { ApiKeyModal } from "../components/api-key-modal";
import { useAuth } from "../hooks/use-auth";
import { truncate, formatDateField } from "../lib/markdown";
import type { Schedule } from "@appstrate/shared-types";

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

type Tab = "executions" | "schedules";

export function FlowDetailPage() {
  const { flowId } = useParams<{ flowId: string }>();
  const { isAdmin } = useAuth();
  const qc = useQueryClient();

  const { data: detail, isLoading, error } = useFlowDetail(flowId);
  const { data: executions } = useExecutions(flowId);
  const { data: schedules } = useSchedules(flowId);
  const runFlow = useRunFlow(flowId!);
  const deleteFlow = useDeleteFlow();
  const connectMutation = useConnect();
  const apiKeyMutation = useConnectApiKey();
  const createSchedule = useCreateSchedule(flowId!);
  const updateSchedule = useUpdateSchedule(flowId!);
  const deleteSchedule = useDeleteSchedule(flowId!);

  const [tab, setTab] = useState<Tab>("executions");
  const [configOpen, setConfigOpen] = useState(false);
  const [stateOpen, setStateOpen] = useState(false);
  const [inputOpen, setInputOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<Schedule | null>(null);
  const [apiKeyService, setApiKeyService] = useState<{
    provider: string;
    id: string;
  } | null>(null);

  useFlowExecutionRealtime(flowId, () => {
    qc.invalidateQueries({ queryKey: ["executions", flowId] });
    qc.invalidateQueries({ queryKey: ["flow", flowId] });
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
          const handleServiceConnect = () => {
            if (svc.authMode === "API_KEY") {
              setApiKeyService({ provider: svc.provider, id: svc.id });
            } else {
              connectMutation.mutate(svc.provider);
            }
          };
          return (
            <button
              key={svc.id}
              type="button"
              className={`service ${isConnected ? "" : "not-connected"}`}
              onClick={!isConnected ? handleServiceConnect : undefined}
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
        {isAdmin && (
          <>
            <button onClick={() => setConfigOpen(true)}>Configurer</button>
            {hasState ? (
              <button onClick={() => setStateOpen(true)}>Etat</button>
            ) : (
              <button disabled title="Aucun etat persiste">
                Etat (vide)
              </button>
            )}
          </>
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
        {isAdmin && detail.source === "user" && (
          <button
            className="btn-danger"
            disabled={detail.runningExecutions > 0 || deleteFlow.isPending}
            title={
              detail.runningExecutions > 0
                ? "Impossible de supprimer pendant une execution"
                : "Supprimer ce flow"
            }
            onClick={() => {
              if (
                confirm(
                  `Supprimer le flow "${detail.displayName}" ? Cette action est irreversible.`,
                )
              ) {
                deleteFlow.mutate(detail.id);
              }
            }}
          >
            Supprimer
          </button>
        )}
      </div>

      <div className="exec-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === "executions"}
          className={`tab ${tab === "executions" ? "active" : ""}`}
          onClick={() => setTab("executions")}
        >
          Executions
        </button>
        <button
          role="tab"
          aria-selected={tab === "schedules"}
          className={`tab ${tab === "schedules" ? "active" : ""}`}
          onClick={() => setTab("schedules")}
        >
          Planifications{schedules && schedules.length > 0 ? ` (${schedules.length})` : ""}
        </button>
      </div>

      {tab === "executions" && (
        <>
          {!executions || executions.length === 0 ? (
            <div className="empty-state empty-state-compact">
              <p className="empty-hint">Aucune execution</p>
            </div>
          ) : (
            <div className="exec-list">
              {executions.map((exec) => {
                const date = exec.started_at ? formatDateField(exec.started_at) : "";
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
                    {exec.schedule_id && <span className="tag">cron</span>}
                  </Link>
                );
              })}
            </div>
          )}
        </>
      )}

      {tab === "schedules" && (
        <>
          <div className="section-header">
            <div />
            <button
              onClick={() => {
                setEditingSchedule(null);
                setScheduleOpen(true);
              }}
            >
              Ajouter
            </button>
          </div>
          {!schedules || schedules.length === 0 ? (
            <div className="empty-state empty-state-compact">
              <p className="empty-hint">Aucune planification</p>
            </div>
          ) : (
            <div className="schedule-list">
              {schedules.map((sched) => (
                <ScheduleRow
                  key={sched.id}
                  schedule={sched}
                  onClick={() => {
                    setEditingSchedule(sched);
                    setScheduleOpen(true);
                  }}
                />
              ))}
            </div>
          )}
        </>
      )}

      <ConfigModal open={configOpen} onClose={() => setConfigOpen(false)} flow={detail} />
      <StateModal open={stateOpen} onClose={() => setStateOpen(false)} flow={detail} />
      <InputModal
        open={inputOpen}
        onClose={() => setInputOpen(false)}
        flow={detail}
        onSubmit={(input) => runFlow.mutate(input)}
      />
      <ScheduleModal
        open={scheduleOpen}
        onClose={() => {
          setScheduleOpen(false);
          setEditingSchedule(null);
        }}
        schedule={editingSchedule}
        inputSchema={detail.input?.schema}
        onSave={(data) => {
          if (editingSchedule) {
            updateSchedule.mutate({ id: editingSchedule.id, ...data });
          } else {
            createSchedule.mutate(data);
          }
        }}
        onDelete={
          editingSchedule
            ? () => {
                deleteSchedule.mutate(editingSchedule.id);
                setScheduleOpen(false);
                setEditingSchedule(null);
              }
            : undefined
        }
        isPending={createSchedule.isPending || updateSchedule.isPending}
      />
      <ApiKeyModal
        open={!!apiKeyService}
        onClose={() => setApiKeyService(null)}
        providerName={apiKeyService?.id ?? ""}
        isPending={apiKeyMutation.isPending}
        onSubmit={(apiKey) => {
          if (apiKeyService) {
            apiKeyMutation.mutate(
              { provider: apiKeyService.provider, apiKey },
              { onSuccess: () => setApiKeyService(null) },
            );
          }
        }}
      />
    </>
  );
}
