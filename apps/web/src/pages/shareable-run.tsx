import { useState, useCallback, useMemo } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useFlowDetail } from "../hooks/use-flows";
import { useExecutionRealtime } from "../hooks/use-realtime";
import { useConnect, useConnectApiKey } from "../hooks/use-mutations";
import { InputFields } from "../components/input-fields";
import { initInputValues, buildInputPayload } from "../components/input-utils";
import { ResultRenderer } from "../components/result-renderer";
import { ApiKeyModal } from "../components/api-key-modal";
import { Spinner } from "../components/spinner";
import { api, uploadFormData } from "../api";

type PageStatus = "idle" | "running" | "success" | "failed" | "timeout";

export function ShareableRunPage() {
  const { t } = useTranslation(["flows", "common"]);
  const { flowId } = useParams<{ flowId: string }>();
  const { data: flow, isLoading, error } = useFlowDetail(flowId);
  const connectMutation = useConnect();
  const apiKeyMutation = useConnectApiKey();

  const [executionId, setExecutionId] = useState<string | null>(null);
  const [status, setStatus] = useState<PageStatus>("idle");
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [execError, setExecError] = useState<string | null>(null);
  const [apiKeyService, setApiKeyService] = useState<{
    provider: string;
    id: string;
  } | null>(null);

  const schema = flow?.input?.schema;
  const hasInput = !!schema?.properties && Object.keys(schema.properties).length > 0;

  const initialInputValues = useMemo(() => (schema ? initInputValues(schema) : {}), [schema]);
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const mergedInputValues = useMemo(
    () => ({ ...initialInputValues, ...inputValues }),
    [initialInputValues, inputValues],
  );
  const [fileValues, setFileValues] = useState<Record<string, File[]>>({});

  const handleStatusChange = useCallback((payload: Record<string, unknown>) => {
    const newStatus = payload.status as string;
    if (newStatus === "success" || newStatus === "failed" || newStatus === "timeout") {
      setStatus(newStatus as PageStatus);
      if (newStatus === "success" && payload.result) {
        setResult(payload.result as Record<string, unknown>);
      } else if (newStatus === "failed") {
        setExecError((payload.error as string) || t("shareable.errorFailed"));
      } else if (newStatus === "timeout") {
        setExecError(t("shareable.errorTimeout"));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useExecutionRealtime(executionId, handleStatusChange);

  const services = flow?.requires?.services ?? [];
  const allConnected = services.every((s) => s.status === "connected");

  const handleRun = async () => {
    if (!flowId) return;
    setStatus("running");
    setResult(null);
    setExecError(null);

    try {
      const input = schema ? buildInputPayload(schema, mergedInputValues) : undefined;
      const hasFiles = Object.values(fileValues).some((f) => f.length > 0);

      let data: { executionId: string };
      if (hasFiles) {
        const fd = new FormData();
        if (input && Object.keys(input).length > 0) {
          fd.append("input", JSON.stringify(input));
        }
        for (const [key, files] of Object.entries(fileValues)) {
          for (const file of files) {
            fd.append(key, file);
          }
        }
        data = await uploadFormData<{ executionId: string }>(`/flows/${flowId}/run`, fd);
      } else {
        data = await api<{ executionId: string }>(`/flows/${flowId}/run`, {
          method: "POST",
          body: JSON.stringify(input ? { input } : {}),
        });
      }
      setExecutionId(data.executionId);
    } catch (err) {
      setStatus("failed");
      setExecError(err instanceof Error ? err.message : t("error.unknown"));
    }
  };

  const handleRestart = () => {
    setExecutionId(null);
    setStatus("idle");
    setResult(null);
    setExecError(null);
    setFileValues({});
  };

  if (isLoading) {
    return (
      <div className="shareable-run">
        <div className="shareable-run-card">
          <div className="empty-state">
            <Spinner />
          </div>
        </div>
      </div>
    );
  }

  if (error || !flow) {
    return (
      <div className="shareable-run">
        <div className="shareable-run-card">
          <div className="exec-error">{error?.message || t("shareable.notFound")}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="shareable-run">
      <div className="shareable-run-card">
        <div className="shareable-run-header">
          <h2>{flow.displayName}</h2>
          {flow.description && <p className="description">{flow.description}</p>}
        </div>

        {services.length > 0 && (
          <div className="shareable-run-services">
            {services.map((svc) => {
              const isConnected = svc.status === "connected";
              const isAdminMode = svc.connectionMode === "admin";

              if (isAdminMode) {
                return (
                  <div
                    key={svc.id}
                    className={`service ${svc.adminProvided && isConnected ? "admin-provided" : "admin-pending"}`}
                    title={svc.description}
                  >
                    <span
                      className={`status-dot ${svc.adminProvided && isConnected ? "connected" : "disconnected"}`}
                    />
                    {svc.id}
                    {svc.adminProvided && isConnected && svc.adminDisplayName && (
                      <span className="admin-service-badge">{svc.adminDisplayName}</span>
                    )}
                    {!(svc.adminProvided && isConnected) && (
                      <span className="admin-service-badge pending">{t("detail.pending")}</span>
                    )}
                  </div>
                );
              }

              // User-mode service
              if (isConnected) {
                return (
                  <div key={svc.id} className="service" title={svc.description}>
                    <span className="status-dot connected" />
                    {svc.id}
                  </div>
                );
              }

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
                  className="service not-connected"
                  onClick={handleServiceConnect}
                  title={svc.description}
                >
                  <span className="status-dot disconnected" />
                  {svc.id} ({t("detail.connect")})
                </button>
              );
            })}
          </div>
        )}

        {status === "idle" && (
          <div className="shareable-run-form">
            {hasInput && (
              <InputFields
                schema={schema!}
                values={mergedInputValues}
                onChange={(key, value) => setInputValues((prev) => ({ ...prev, [key]: value }))}
                fileValues={fileValues}
                onFileChange={(key, files) => setFileValues((prev) => ({ ...prev, [key]: files }))}
                idPrefix="shareable-input"
              />
            )}
            <button
              className="primary shareable-run-btn"
              onClick={handleRun}
              disabled={!allConnected}
              title={!allConnected ? t("shareable.connectFirst") : t("shareable.titleRun")}
            >
              {t("shareable.execute")}
            </button>
          </div>
        )}

        {status === "running" && (
          <div className="shareable-run-status">
            <Spinner />
            <span>{t("shareable.running")}</span>
          </div>
        )}

        {(status === "success" || status === "failed" || status === "timeout") && (
          <div className="shareable-run-result">
            {execError && <div className="exec-error">{execError}</div>}
            {result && <ResultRenderer data={result} outputSchema={flow.output?.schema} />}
            <button className="shareable-run-btn" onClick={handleRestart}>
              {t("shareable.rerun")}
            </button>
          </div>
        )}
      </div>

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
    </div>
  );
}
