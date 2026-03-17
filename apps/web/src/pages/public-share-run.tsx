import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { JSONSchemaObject, ProviderStatus } from "@appstrate/shared-types";
import { FlowRunCard, type RunCardStatus } from "../components/flow-run-card";
import { buildLogEntries, type RawLog } from "../components/log-viewer";

interface FlowInfo {
  displayName: string;
  description?: string;
  input?: { schema: JSONSchemaObject };
  output?: { schema: JSONSchemaObject };
  providers?: ProviderStatus[];
  consumed: boolean;
  execution?: {
    id: string;
    status: string;
    result?: Record<string, unknown>;
    error?: string;
  };
}

const POLL_INTERVAL_MS = 2000;

function resolveExecutionStatus(
  status: string,
  t: TFunction,
): { pageStatus: RunCardStatus; error: string | null } {
  switch (status) {
    case "success":
      return { pageStatus: "success", error: null };
    case "failed":
      return { pageStatus: "failed", error: t("shareable.errorFailed") };
    case "timeout":
      return { pageStatus: "timeout", error: t("shareable.errorTimeout") };
    default:
      return { pageStatus: "running", error: null };
  }
}

export function PublicShareRunPage() {
  const { t } = useTranslation(["flows", "common"]);
  const { token } = useParams<{ token: string }>();
  const [status, setStatus] = useState<RunCardStatus>("loading");
  const [flowInfo, setFlowInfo] = useState<FlowInfo | null>(null);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rawLogs, setRawLogs] = useState<RawLog[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const logEntries = useMemo(() => {
    const { entries } = buildLogEntries(rawLogs);
    return entries.filter((e) => e.level && e.level !== "debug");
  }, [rawLogs]);

  // Fetch flow info on mount
  useEffect(() => {
    if (!token) return;
    fetch(`/share/${token}/flow`)
      .then(async (res) => {
        if (!res.ok) {
          setStatus("invalid");
          return;
        }
        const data: FlowInfo = await res.json();
        setFlowInfo(data);
        if (data.consumed && data.execution) {
          const resolved = resolveExecutionStatus(data.execution.status, t);
          setStatus(resolved.pageStatus);
          if (resolved.error) setError(data.execution.error || resolved.error);
          if (data.execution.result) setResult(data.execution.result);
        } else if (data.consumed) {
          setStatus("invalid");
        } else {
          setStatus("idle");
        }
      })
      .catch(() => setStatus("invalid"));
  }, [token, t]);

  // Polling
  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const poll = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch(`/share/${token}/status`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.logs) setRawLogs(data.logs as RawLog[]);
      const resolved = resolveExecutionStatus(data.status as string, t);
      if (resolved.pageStatus !== "running") {
        setStatus(resolved.pageStatus);
        if (resolved.error) setError(data.error || resolved.error);
        if (data.result) setResult(data.result as Record<string, unknown>);
        stopPolling();
      }
    } catch {
      /* ignore */
    }
  }, [token, stopPolling, t]);

  const startPolling = useCallback(() => {
    stopPolling();
    poll();
    pollRef.current = setInterval(poll, POLL_INTERVAL_MS);
  }, [poll, stopPolling]);

  useEffect(() => {
    if (status === "running") startPolling();
    return stopPolling;
  }, [status, startPolling, stopPolling]);

  // Run handler
  const handleRun = async (input?: Record<string, unknown>, files?: Record<string, File[]>) => {
    if (!token) return;
    setError(null);
    setSubmitting(true);

    try {
      const hasFiles = files && Object.values(files).some((f) => f.length > 0);

      let res: Response;
      if (hasFiles) {
        const fd = new FormData();
        if (input && Object.keys(input).length > 0) {
          fd.append("input", JSON.stringify(input));
        }
        for (const [key, fileList] of Object.entries(files!)) {
          for (const file of fileList) fd.append(key, file);
        }
        res = await fetch(`/share/${token}/run`, { method: "POST", body: fd });
      } else {
        res = await fetch(`/share/${token}/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input ? { input } : {}),
        });
      }

      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: res.statusText }));
        if (res.status === 410) {
          setStatus("invalid");
          return;
        }
        setError(err.message || `Error ${res.status}`);
        return;
      }

      await res.json();
      setResult(null);
      setRawLogs([]);
      setStatus("running");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("error.unknown"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <FlowRunCard
      displayName={flowInfo?.displayName}
      description={flowInfo?.description}
      inputSchema={flowInfo?.input?.schema}
      outputSchema={flowInfo?.output?.schema}
      providers={flowInfo?.providers}
      status={status}
      error={error}
      result={result}
      logEntries={logEntries}
      submitting={submitting}
      onRun={handleRun}
    />
  );
}
