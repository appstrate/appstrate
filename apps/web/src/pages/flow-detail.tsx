import { useState } from "react";
import { useParams, Link, Navigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useFlowDetail } from "../hooks/use-flows";
import { useCurrentProfileId, profileIdParam } from "../hooks/use-current-profile";
import { ProfileSelector } from "../components/profile-selector";
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
  useDeleteFlowExecutions,
  useConnectApiKey,
  useConnectCredentials,
  useBindAdminService,
  useUnbindAdminService,
  useDisconnect,
} from "../hooks/use-mutations";
import { Badge } from "../components/badge";
import { ConfigModal } from "../components/config-modal";
import { InputModal } from "../components/input-modal";
import { ScheduleModal } from "../components/schedule-modal";
import { ScheduleRow } from "../components/schedule-row";
import { ApiKeyModal } from "../components/api-key-modal";
import { CustomCredentialsModal } from "../components/custom-credentials-modal";
import { ShareDropdown } from "../components/share-dropdown";
import { useOrg } from "../hooks/use-org";
import { useProviders } from "../hooks/use-providers";
import { truncate, formatDateField } from "../lib/markdown";
import { LoadingState, EmptyState } from "../components/page-states";
import { Spinner } from "../components/spinner";
import type { Schedule, JSONSchemaObject } from "@appstrate/shared-types";

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
  const { isOrgAdmin } = useOrg();

  const profileId = useCurrentProfileId();
  const pParam = profileIdParam(profileId);
  const { data: detail, isLoading, error } = useFlowDetail(flowId);
  const { data: executions } = useExecutions(flowId);
  const { data: schedules } = useSchedules(flowId);
  const { data: providers } = useProviders();
  const profileMap = useProfiles(
    (executions ?? []).map((e) => e.userId).filter((id): id is string => !!id),
  );
  const runFlow = useRunFlow(flowId!);
  const deleteFlow = useDeleteFlow();
  const deleteExecutions = useDeleteFlowExecutions(flowId!);
  const connectMutation = useConnect();
  const apiKeyMutation = useConnectApiKey();
  const credentialsMutation = useConnectCredentials();
  const bindAdmin = useBindAdminService(flowId!);
  const unbindAdmin = useUnbindAdminService(flowId!);
  const disconnectMutation = useDisconnect();
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
  const [customCredService, setCustomCredService] = useState<{
    provider: string;
    id: string;
    name?: string;
    bindAfter?: boolean;
  } | null>(null);

  if (isLoading) return <LoadingState />;

  if (error || !detail) return <Navigate to="/" replace />;

  // Look up provider's credentialSchema for custom credential modal
  const customCredProviderDef = customCredService
    ? providers?.find((p) => p.id === customCredService.provider)
    : undefined;
  const customCredSchema =
    (customCredProviderDef?.credentialSchema as JSONSchemaObject | undefined) ?? undefined;

  const allConnected = detail.requires.services.every(
    (s) =>
      (s.status === "connected" || s.status === "needs_reconnection") &&
      s.scopesSufficient !== false,
  );
  const hasReconnectionNeeded = detail.requires.services.some(
    (s) => s.status === "needs_reconnection",
  );
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

  /** Resolve provider authMode for a service */
  const getServiceAuthMode = (svc: { provider: string; authMode?: string }): string | undefined => {
    // First from the service status (backend-resolved)
    if (svc.authMode) return svc.authMode;
    // Fallback: look up provider definition
    const pDef = providers?.find((p) => p.id === svc.provider);
    return pDef?.authMode === "api_key"
      ? "API_KEY"
      : pDef?.authMode === "oauth2"
        ? "OAUTH2"
        : undefined;
  };

  /** Check if a provider uses credential-based auth (basic/custom) */
  const isCredentialAuth = (provider: string): boolean => {
    const pDef = providers?.find((p) => p.id === provider);
    return pDef?.authMode === "basic" || pDef?.authMode === "custom";
  };

  return (
    <>
      <nav className="breadcrumb">
        <Link to="/">{t("detail.breadcrumb")}</Link>
        <span className="separator">/</span>
        <span className="current">{detail.displayName}</span>
      </nav>

      <div className="flow-detail-header">
        <div className="header-row">
          <h2>{detail.displayName}</h2>
          <ProfileSelector />
        </div>
        <p className="description">{detail.description}</p>
      </div>

      <div className="services">
        {detail.requires.services.map((svc) => {
          const isConnected = svc.status === "connected";
          const isAdminMode = svc.connectionMode === "admin";
          const authMode = getServiceAuthMode(svc);

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
                  if (authMode === "API_KEY") {
                    setApiKeyService({ provider: svc.provider, id: svc.id, bindAfter: true });
                    return;
                  }
                  if (isCredentialAuth(svc.provider)) {
                    setCustomCredService({
                      provider: svc.provider,
                      id: svc.id,
                      name: svc.name,
                      bindAfter: true,
                    });
                    return;
                  }
                  await connectMutation.mutateAsync({
                    provider: svc.provider,
                    scopes: svc.scopesRequired,
                  });
                  await bindAdmin.mutateAsync(svc.id);
                } catch (retryErr) {
                  const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
                  alert(t("error.prefix", { message: retryMsg }));
                }
              }
            };

            if (svc.adminProvided && isConnected) {
              return (
                <div key={svc.id} className="service admin-provided" title={svc.description}>
                  <span className="status-dot connected" />
                  {svc.name || svc.id}
                  <span className="admin-service-badge">{t("admin")}</span>
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
                {svc.name || svc.id}
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
          const needsReconnection = svc.status === "needs_reconnection";
          const handleServiceConnect = () => {
            if (authMode === "API_KEY") {
              setApiKeyService({ provider: svc.provider, id: svc.id });
            } else if (isCredentialAuth(svc.provider)) {
              setCustomCredService({
                provider: svc.provider,
                id: svc.id,
                name: svc.name,
              });
            } else {
              connectMutation.mutate({
                provider: svc.provider,
                scopes: svc.scopesRequired,
                ...pParam,
              });
            }
          };
          const hasScopeIssue = isConnected && svc.scopesSufficient === false;
          if (needsReconnection) {
            return (
              <div key={svc.id} className="service needs-reconnection" title={svc.description}>
                <span className="status-dot warning" />
                {svc.name || svc.id}
                <button
                  type="button"
                  className="btn-scope-upgrade"
                  onClick={handleServiceConnect}
                  disabled={connectMutation.isPending}
                >
                  {t("detail.reconnect", { defaultValue: "Reconnect" })}
                </button>
              </div>
            );
          }
          if (isConnected) {
            return (
              <div
                key={svc.id}
                className={`service${hasScopeIssue ? " scope-warning" : ""}`}
                title={svc.description}
              >
                <span className={`status-dot ${hasScopeIssue ? "warning" : "connected"}`} />
                {svc.name || svc.id}
                {hasScopeIssue && svc.scopesMissing && (
                  <button
                    type="button"
                    className="btn-scope-upgrade"
                    onClick={handleServiceConnect}
                    disabled={connectMutation.isPending}
                    title={`Missing: ${svc.scopesMissing.join(", ")}`}
                  >
                    {t("detail.updatePermissions", { defaultValue: "Update permissions" })}
                  </button>
                )}
                <button
                  type="button"
                  className="btn-unbind"
                  onClick={() => {
                    if (confirm(t("detail.disconnectConfirm", { name: svc.name || svc.id }))) {
                      disconnectMutation.mutate({
                        provider: svc.provider,
                        ...pParam,
                      });
                    }
                  }}
                  disabled={disconnectMutation.isPending}
                >
                  {t("detail.disconnect")}
                </button>
              </div>
            );
          }
          return (
            <button
              key={svc.id}
              type="button"
              className="service not-connected"
              onClick={handleServiceConnect}
              title={svc.description}
            >
              <span className="status-dot disconnected" />
              {svc.name || svc.id}
              {` (${t("detail.connect")})`}
            </button>
          );
        })}
      </div>

      <div className="actions">
        <button
          className="primary"
          onClick={handleRun}
          disabled={
            !allConnected || hasReconnectionNeeded || !hasRequiredConfig || runFlow.isPending
          }
          title={
            hasReconnectionNeeded
              ? t("detail.titleReconnect", { defaultValue: "Reconnect services first" })
              : !allConnected
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
            {hasConfigSchema && (
              <button onClick={() => setConfigOpen(true)}>{t("detail.configure")}</button>
            )}
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
                  if (confirm(t("detail.deleteConfirm", { name: detail.displayName }))) {
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
          {t("detail.tabSchedules")}
          {schedules && schedules.length > 0 ? ` (${schedules.length})` : ""}
        </button>
      </div>

      {tab === "executions" && (
        <>
          {isOrgAdmin && executions && executions.length > 0 && (
            <div className="section-header">
              <div />
              <button
                className="btn-danger"
                disabled={detail.runningExecutions > 0 || deleteExecutions.isPending}
                title={
                  detail.runningExecutions > 0
                    ? t("detail.clearExecRunning")
                    : t("detail.clearExec")
                }
                onClick={() => {
                  if (confirm(t("detail.clearExecConfirm"))) {
                    deleteExecutions.mutate();
                  }
                }}
              >
                {t("detail.clearExec")}
              </button>
            </div>
          )}
          {!executions || executions.length === 0 ? (
            <EmptyState message={t("detail.emptyExec")} compact />
          ) : (
            <div className="exec-list">
              {executions.map((exec) => {
                const date = exec.startedAt ? formatDateField(exec.startedAt) : "";
                const duration = exec.duration ? `${(exec.duration / 1000).toFixed(1)}s` : "";
                const inputPreview = exec.input ? truncate(JSON.stringify(exec.input), 60) : "";

                const userName = exec.userId ? profileMap.get(exec.userId) : undefined;

                return (
                  <Link
                    key={exec.id}
                    className="exec-row"
                    to={`/flows/${flowId}/executions/${exec.id}`}
                  >
                    <Badge status={exec.status} />
                    {userName && (
                      <span className="exec-user">{t("exec.user", { name: userName })}</span>
                    )}
                    <span className="exec-date">{date}</span>
                    {duration && <span className="exec-duration">{duration}</span>}
                    {exec.tokensUsed != null && (
                      <span className="exec-tokens">{exec.tokensUsed.toLocaleString()} tok</span>
                    )}
                    {inputPreview && <span className="exec-input-preview">{inputPreview}</span>}
                    {exec.scheduleId && <span className="tag">cron</span>}
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
              { provider: apiKeyService.provider, apiKey, ...pParam },
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
      {customCredService && customCredSchema && (
        <CustomCredentialsModal
          open
          onClose={() => setCustomCredService(null)}
          schema={customCredSchema}
          serviceId={customCredService.id}
          serviceName={customCredService.name}
          isPending={credentialsMutation.isPending}
          onSubmit={(credentials) => {
            const { provider, id: serviceId, bindAfter } = customCredService;
            credentialsMutation.mutate(
              { provider, credentials, ...pParam },
              {
                onSuccess: () => {
                  setCustomCredService(null);
                  if (bindAfter) {
                    bindAdmin.mutate(serviceId);
                  }
                },
              },
            );
          }}
        />
      )}
    </>
  );
}
