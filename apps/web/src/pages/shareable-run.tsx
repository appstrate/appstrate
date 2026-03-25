import { useState, useCallback, useMemo, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { ProviderStatus, ExecutionLog } from "@appstrate/shared-types";
import { usePackageDetail } from "../hooks/use-packages";
import { useExecutionRealtime, useExecutionLogsRealtime } from "../hooks/use-realtime";
import { useExecution, useExecutionLogs } from "../hooks/use-executions";
import { useConnect, useConnectApiKey } from "../hooks/use-mutations";
import { useCurrentOrgId } from "../hooks/use-org";
import { useQueryClient } from "@tanstack/react-query";
import { ApiKeyModal } from "../components/api-key-modal";
import { FlowRunCard, type RunCardStatus } from "../components/flow-run-card";
import { buildLogEntries, type RawLog } from "../components/log-utils";
import { api, uploadFormData } from "../api";

export function ShareableRunPage() {
  const { t } = useTranslation(["flows", "common"]);
  const {
    scope,
    name,
    execId: urlExecId,
  } = useParams<{
    scope: string;
    name: string;
    execId?: string;
  }>();
  const navigate = useNavigate();
  const packageId = `${scope}/${name}`;
  const orgId = useCurrentOrgId();
  const qc = useQueryClient();
  const { data: flow, isLoading, error: loadError } = usePackageDetail("flow", packageId);
  const connectMutation = useConnect();
  const apiKeyMutation = useConnectApiKey();

  const [executionId, setExecutionId] = useState<string | null>(urlExecId ?? null);
  const [status, setStatus] = useState<RunCardStatus>(urlExecId ? "running" : "idle");
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [execError, setExecError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [apiKeyService, setApiKeyService] = useState<{
    provider: string;
    id: string;
  } | null>(null);

  const isRunning = status === "running";

  // Fetch execution record (for result on completion + resume after reload)
  const { data: execution } = useExecution(executionId ?? undefined);

  // Restore/sync state from execution record (on mount, reload, or SSE-triggered refetch)
  useEffect(() => {
    if (!execution) return;
    const s = execution.status;
    if (s === "success") {
      setStatus("success");
      if (execution.result) {
        const r = execution.result as { data?: Record<string, unknown> };
        setResult(r.data ?? null);
      }
    } else if (s === "failed") {
      setStatus("failed");
      setExecError((execution.error as string) || t("shareable.errorFailed"));
    } else if (s === "timeout") {
      setStatus("timeout");
      setExecError(t("shareable.errorTimeout"));
    } else if (s === "running" || s === "pending") {
      setStatus("running");
    }
  }, [execution?.status, execution?.result]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch logs for the current execution
  const { data: logs } = useExecutionLogs(executionId ?? undefined);

  // Subscribe to new log INSERTs via SSE while execution is running
  useExecutionLogsRealtime(
    isRunning ? (executionId ?? null) : null,
    useCallback(
      (newLog: Record<string, unknown>) => {
        const log = newLog as unknown as ExecutionLog;
        qc.setQueryData<ExecutionLog[]>(["execution-logs", orgId, executionId], (prev) => {
          if (!prev) return [log];
          if (prev.some((l) => l.id === log.id)) return prev;
          return [...prev, log];
        });
      },
      [qc, orgId, executionId],
    ),
  );

  const logEntries = useMemo(() => {
    if (!logs) return [];
    const { entries } = buildLogEntries(logs as RawLog[]);
    return entries.filter((e) => e.level && e.level !== "debug");
  }, [logs]);

  // SSE for execution status — on terminal, refetch execution + logs to get result
  useExecutionRealtime(
    isRunning ? executionId : null,
    useCallback(
      (payload: Record<string, unknown>) => {
        const newStatus = payload.status as string;
        const terminal =
          newStatus === "success" || newStatus === "failed" || newStatus === "timeout";
        if (terminal) {
          setStatus(newStatus as RunCardStatus);
          if (newStatus === "failed") {
            setExecError((payload.error as string) || t("shareable.errorFailed"));
          } else if (newStatus === "timeout") {
            setExecError(t("shareable.errorTimeout"));
          }
          // Refetch execution (for result) + logs (for completeness)
          if (executionId) {
            qc.invalidateQueries({ queryKey: ["execution", orgId, executionId] });
            qc.invalidateQueries({ queryKey: ["execution-logs", orgId, executionId] });
          }
        }
      },
      [t, qc, orgId, executionId],
    ),
  );

  const providers = flow?.dependencies?.providers ?? [];
  const allConnected = providers.every((s) => s.status === "connected");

  const handleRun = async (input?: Record<string, unknown>, files?: Record<string, File[]>) => {
    if (!packageId) return;
    setExecError(null);
    setSubmitting(true);

    try {
      const hasFiles = files && Object.values(files).some((f) => f.length > 0);

      let data: { executionId: string };
      if (hasFiles) {
        const fd = new FormData();
        if (input && Object.keys(input).length > 0) {
          fd.append("input", JSON.stringify(input));
        }
        for (const [key, fileList] of Object.entries(files!)) {
          for (const file of fileList) fd.append(key, file);
        }
        data = await uploadFormData<{ executionId: string }>(`/flows/${packageId}/run`, fd);
      } else {
        data = await api<{ executionId: string }>(`/flows/${packageId}/run`, {
          method: "POST",
          body: JSON.stringify(input ? { input } : {}),
        });
      }

      setExecutionId(data.executionId);
      setResult(null);
      setStatus("running");
      navigate(`/flows/${packageId}/run/${data.executionId}`, { replace: true });
    } catch (err) {
      setExecError(err instanceof Error ? err.message : t("error.unknown"));
    } finally {
      setSubmitting(false);
    }
  };

  const handleRerun = () => {
    setExecutionId(null);
    setStatus("idle");
    setResult(null);
    setExecError(null);
    navigate(`/flows/${packageId}/run`, { replace: true });
  };

  const handleProviderConnect = (svc: ProviderStatus) => {
    if (svc.authMode === "API_KEY") {
      setApiKeyService({ provider: svc.provider, id: svc.id });
    } else {
      connectMutation.mutate(svc.provider);
    }
  };

  const cardStatus: RunCardStatus = isLoading ? "loading" : loadError ? "invalid" : status;

  return (
    <>
      <FlowRunCard
        displayName={flow?.displayName}
        description={flow?.description}
        inputSchema={flow?.input?.schema}
        providers={providers}
        status={cardStatus}
        error={execError ?? loadError?.message}
        result={result}
        logEntries={logEntries}
        submitting={submitting}
        onRun={handleRun}
        onRerun={handleRerun}
        onProviderConnect={handleProviderConnect}
        canRun={allConnected}
        canRunTitle={!allConnected ? t("shareable.connectFirst") : undefined}
        invalidMessage={loadError?.message}
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
