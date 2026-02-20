import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useFlowDetail } from "../hooks/use-flows";
import { useExecutions } from "../hooks/use-executions";
import { useProfiles } from "../hooks/use-profiles";
import {
  useSchedules,
  useCreateSchedule,
  useUpdateSchedule,
  useDeleteSchedule,
} from "../hooks/use-schedules";
import {
  useRunFlow,
  useConnect,
  useDeleteFlow,
  useConnectApiKey,
  useBindAdminService,
  useUnbindAdminService,
} from "../hooks/use-mutations";
import { Badge } from "../components/badge";
import { ConfigModal } from "../components/config-modal";
import { InputModal } from "../components/input-modal";
import { ScheduleModal } from "../components/schedule-modal";
import { ScheduleRow } from "../components/schedule-row";
import { ApiKeyModal } from "../components/api-key-modal";
import { ShareDropdown } from "../components/share-dropdown";
import { useAuth } from "../hooks/use-auth";
import { useOrg } from "../hooks/use-org";
import { truncate, formatDateField } from "../lib/markdown";
import { LoadingState, ErrorState, EmptyState } from "../components/page-states";
import { Spinner } from "../components/spinner";
import type { Schedule } from "@appstrate/shared-types";

function checkRequiredConfig(detail: {
  config: {
    schema: { properties: Record<string, unknown>; required?: string[] };
    current: Record<string, unknown>;
  };
}): boolean {
  const schema = detail.config?.schema;
  const current = detail.config?.current || {};
  if (!schema?.properties) return true;
  for (const key of schema.required || []) {
    if (current[key] === undefined || current[key] === null || current[key] === "") {
      return false;
    }
  }
  return true;
}

type Tab = "executions" | "schedules";

export function FlowDetailPage() {
  const { t } = useTranslation(["flows", "common"]);
  const { flowId } = useParams<{ flowId: string }>();
  const { user } = useAuth();
  const { isOrgAdmin } = useOrg();

  const { data: detail, isLoading, error } = useFlowDetail(flowId);
  const { data: executions } = useExecutions(flowId);
  const { data: schedules } = useSchedules(flowId);
  const profileMap = useProfiles(
    (executions ?? []).map((e) => e.user_id).filter((id): id is string => !!id),
  );
  const runFlow = useRunFlow(flowId!);
  const deleteFlow = useDeleteFlow();
  const connectMutation = useConnect();
  const apiKeyMutation = useConnectApiKey();
  const bindAdmin = useBindAdminService(flowId!);
  const unbindAdmin = useUnbindAdminService(flowId!);
  const createSchedule = useCreateSchedule(flowId!);
  const updateSchedule = useUpdateSchedule();
  const deleteSchedule = useDeleteSchedule();

  const [tab, setTab] = useState<Tab>("executions");
  const [configOpen, setConfigOpen] = useState(false);
  const [inputOpen, setInputOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<Schedule | null>(null);
  const [apiKeyService, setApiKeyService] = useState<{
    provider: string;
    id: string;
    bindAfter?: boolean;
  } | null>(null);

  if (isLoading) return <LoadingState />;

  if (error || !detail) return <ErrorState message={error?.message} />;

  const allConnected = detail.requires.services.every((s) => s.status === "connected");
  const hasRequiredConfig = checkRequiredConfig(detail);
  const hasInputSchema =
    detail.input?.schema?.properties && Object.keys(detail.input.schema.properties).length > 0;
  const hasConfigSchema =
    detail.config?.schema?.properties && Object.keys(detail.config.schema.properties).length > 0;

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
        <Link to="/">{t("detail.breadcrumb")}</Link>
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
          const isAdminMode = svc.connectionMode === "admin";

          // Admin-provided service
          if (isAdminMode) {
            const handleBind = async () => {
              try {
                await bindAdmin.mutateAsync(svc.id);
              } catch (err) {
                const msg = err instanceof Error ? err.message : "";
                if (!msg.includes("connexion active")) {
                  alert(t("error.prefix", { message: msg }));
                  return;
                }
                // Admin not connected to the provider — open connect flow then retry
                try {
                  if (svc.authMode === "API_KEY") {
                    setApiKeyService({ provider: svc.provider, id: svc.id, bindAfter: true });
                    return;
                  }
                  await connectMutation.mutateAsync(svc.provider);
                  await bindAdmin.mutateAsync(svc.id);
                } catch (retryErr) {
                  const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
                  alert(t("error.prefix", { message: retryMsg }));
                }
              }
            };

            if (svc.adminProvided && isConnected) {
              const isSelf = svc.adminUserId === user?.id;
              return (
                <div key={svc.id} className="service admin-provided" title={svc.description}>
                  <span className="status-dot connected" />
                  {svc.id}
                  {!isSelf && (
                    <span className="admin-service-badge">{svc.adminDisplayName ?? t("admin")}</span>
                  )}
                  {isOrgAdmin && (
                    <button
                      type="button"
                      className="btn-unbind"
                      onClick={() => unbindAdmin.mutate(svc.id)}
                      disabled={unbindAdmin.isPending}
                    >
                      {t("detail.unbind")}
                    </button>
                  )}
                </div>
              );
            }
            // Admin mode but not yet bound
            return (
              <div key={svc.id} className="service admin-pending" title={svc.description}>
                <span className="status-dot disconnected" />
                {svc.id}
                {isOrgAdmin ? (
                  <button
                    type="button"
                    className="btn-bind"
                    onClick={handleBind}
                    disabled={bindAdmin.isPending || connectMutation.isPending}
                  >
                    {t("detail.bindAccount")}
                  </button>
                ) : (
                  <span className="admin-service-badge pending">{t("detail.pending")}</span>
                )}
              </div>
            );
          }

          // User mode (default behavior)
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
              {!isConnected && ` (${t("detail.connect")})`}
            </button>
          );
        })}
      </div>

      <div className="actions">
        <button
          className="primary"
          onClick={handleRun}
          disabled={!allConnected || !hasRequiredConfig || runFlow.isPending}
          title={
            !allConnected
              ? t("detail.titleConnect")
              : !hasRequiredConfig
                ? t("detail.titleConfig")
                : t("detail.titleRun")
          }
        >
          {runFlow.isPending && <Spinner />} {t("detail.run")}
        </button>
        <ShareDropdown flowId={flowId!} isAdmin={isOrgAdmin} services={detail.requires.services} />
        {isOrgAdmin && (
          <div className="actions-admin">
            {hasConfigSchema && <button onClick={() => setConfigOpen(true)}>{t("detail.configure")}</button>}
            {detail.source === "user" && (
              <Link to={`/flows/${flowId}/edit`}>
                <button>{t("btn.edit")}</button>
              </Link>
            )}
            {detail.source === "user" && (
              <button
                className="btn-danger"
                disabled={detail.runningExecutions > 0 || deleteFlow.isPending}
                title={
                  detail.runningExecutions > 0
                    ? t("detail.titleDeleteRunning")
                    : t("detail.titleDelete")
                }
                onClick={() => {
                  if (
                    confirm(
                      t("detail.deleteConfirm", { name: detail.displayName }),
                    )
                  ) {
                    deleteFlow.mutate(detail.id);
                  }
                }}
              >
                {t("btn.delete")}
              </button>
            )}
          </div>
        )}
      </div>

      <div className="exec-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === "executions"}
          className={`tab ${tab === "executions" ? "active" : ""}`}
          onClick={() => setTab("executions")}
        >
          {t("detail.tabExecutions")}
        </button>
        <button
          role="tab"
          aria-selected={tab === "schedules"}
          className={`tab ${tab === "schedules" ? "active" : ""}`}
          onClick={() => setTab("schedules")}
        >
          {t("detail.tabSchedules")}{schedules && schedules.length > 0 ? ` (${schedules.length})` : ""}
        </button>
      </div>

      {tab === "executions" && (
        <>
          {!executions || executions.length === 0 ? (
            <EmptyState message={t("detail.emptyExec")} compact />
          ) : (
            <div className="exec-list">
              {executions.map((exec) => {
                const date = exec.started_at ? formatDateField(exec.started_at) : "";
                const duration = exec.duration ? `${(exec.duration / 1000).toFixed(1)}s` : "";
                const inputPreview = exec.input ? truncate(JSON.stringify(exec.input), 60) : "";

                const userName = exec.user_id ? profileMap.get(exec.user_id) : undefined;

                return (
                  <Link
                    key={exec.id}
                    className="exec-row"
                    to={`/flows/${flowId}/executions/${exec.id}`}
                  >
                    <Badge status={exec.status} />
                    {userName && <span className="exec-user">{t("exec.user", { name: userName })}</span>}
                    <span className="exec-date">{date}</span>
                    {duration && <span className="exec-duration">{duration}</span>}
                    {exec.tokens_used != null && (
                      <span className="exec-tokens">{exec.tokens_used.toLocaleString()} tok</span>
                    )}
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
              {t("btn.add")}
            </button>
          </div>
          {!schedules || schedules.length === 0 ? (
            <EmptyState message={t("detail.emptySchedule")} compact />
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
      <InputModal
        open={inputOpen}
        onClose={() => setInputOpen(false)}
        flow={detail}
        onSubmit={(input, files) => runFlow.mutate({ input, files })}
        isPending={runFlow.isPending}
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
            const { id: serviceId, bindAfter } = apiKeyService;
            apiKeyMutation.mutate(
              { provider: apiKeyService.provider, apiKey },
              {
                onSuccess: () => {
                  setApiKeyService(null);
                  if (bindAfter) {
                    bindAdmin.mutate(serviceId);
                  }
                },
              },
            );
          }
        }}
      />
    </>
  );
}
