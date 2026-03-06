import { useState, useCallback, useMemo } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useFlowDetail } from "../hooks/use-packages";
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
  const { scope, name } = useParams<{ scope: string; name: string }>();
  const packageId = `${scope}/${name}`;
  const { data: flow, isLoading, error } = useFlowDetail(packageId);
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
    if (!packageId) return;
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
        data = await uploadFormData<{ executionId: string }>(`/flows/${packageId}/run`, fd);
      } else {
        data = await api<{ executionId: string }>(`/flows/${packageId}/run`, {
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
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="w-full max-w-lg rounded-lg border border-border bg-card p-6 shadow-lg">
          <div className="flex items-center justify-center py-8">
            <Spinner />
          </div>
        </div>
      </div>
    );
  }

  if (error || !flow) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="w-full max-w-lg rounded-lg border border-border bg-card p-6 shadow-lg">
          <div className="rounded-md bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error?.message || t("shareable.notFound")}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-lg rounded-lg border border-border bg-card p-6 shadow-lg">
        <div className="mb-4">
          <h2 className="text-lg font-semibold">{flow.displayName}</h2>
          {flow.description && (
            <p className="text-sm text-muted-foreground mt-1">{flow.description}</p>
          )}
        </div>

        {services.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-4">
            {services.map((svc) => {
              const isConnected = svc.status === "connected";
              const isAdminMode = svc.connectionMode === "admin";

              if (isAdminMode) {
                return (
                  <div
                    key={svc.id}
                    className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm"
                    title={svc.description}
                  >
                    <span
                      className={cn(
                        "h-2 w-2 rounded-full inline-block",
                        svc.adminProvided && isConnected ? "bg-success" : "bg-destructive",
                      )}
                    />
                    {svc.id}
                    {svc.adminProvided && isConnected && (
                      <span className="ml-1 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                        {t("admin")}
                      </span>
                    )}
                    {!(svc.adminProvided && isConnected) && (
                      <span className="ml-1 rounded bg-warning/10 px-1.5 py-0.5 text-xs text-warning">
                        {t("detail.pending")}
                      </span>
                    )}
                  </div>
                );
              }

              // User-mode service
              if (isConnected) {
                return (
                  <div
                    key={svc.id}
                    className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm"
                    title={svc.description}
                  >
                    <span className="h-2 w-2 rounded-full bg-success inline-block" />
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
                <Button
                  key={svc.id}
                  variant="outline"
                  type="button"
                  className="flex items-center gap-1.5 border-dashed px-2.5 py-1.5 text-sm text-muted-foreground hover:border-primary hover:text-foreground"
                  onClick={handleServiceConnect}
                  title={svc.description}
                >
                  <span className="h-2 w-2 rounded-full bg-destructive inline-block" />
                  {svc.id} ({t("detail.connect")})
                </Button>
              );
            })}
          </div>
        )}

        {status === "idle" && (
          <div className="space-y-4">
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
            <Button
              className="w-full"
              onClick={handleRun}
              disabled={!allConnected}
              title={!allConnected ? t("shareable.connectFirst") : t("shareable.titleRun")}
            >
              {t("shareable.execute")}
            </Button>
          </div>
        )}

        {status === "running" && (
          <div className="flex items-center justify-center gap-2 py-6 text-muted-foreground">
            <Spinner />
            <span>{t("shareable.running")}</span>
          </div>
        )}

        {(status === "success" || status === "failed" || status === "timeout") && (
          <div className="space-y-4">
            {execError && (
              <div className="rounded-md bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {execError}
              </div>
            )}
            {result && <ResultRenderer data={result} outputSchema={flow.output?.schema} />}
            <Button variant="outline" className="w-full" onClick={handleRestart}>
              {t("shareable.rerun")}
            </Button>
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
