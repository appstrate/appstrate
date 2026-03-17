import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { JSONSchemaObject, ProviderStatus } from "@appstrate/shared-types";
import { InputFields } from "../components/input-fields";
import { initInputValues, buildInputPayload } from "../components/input-utils";
import { ResultRenderer } from "../components/result-renderer";
import { Spinner } from "../components/spinner";
import { ExecutionTimeline, buildLogEntries, type RawLog } from "../components/log-viewer";

type PageStatus = "loading" | "idle" | "running" | "success" | "failed" | "timeout" | "invalid";

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
): {
  pageStatus: PageStatus;
  error: string | null;
} {
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
  const [pageStatus, setPageStatus] = useState<PageStatus>("loading");
  const [flowInfo, setFlowInfo] = useState<FlowInfo | null>(null);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [execError, setExecError] = useState<string | null>(null);
  const [rawLogs, setRawLogs] = useState<RawLog[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const schema = flowInfo?.input?.schema;
  const hasInput = !!schema?.properties && Object.keys(schema.properties).length > 0;

  const initialInputValues = useMemo(() => (schema ? initInputValues(schema) : {}), [schema]);
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const mergedInputValues = useMemo(
    () => ({ ...initialInputValues, ...inputValues }),
    [initialInputValues, inputValues],
  );
  const [fileValues, setFileValues] = useState<Record<string, File[]>>({});

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
          setPageStatus("invalid");
          return;
        }
        const data: FlowInfo = await res.json();
        setFlowInfo(data);

        if (data.consumed && data.execution) {
          const resolved = resolveExecutionStatus(data.execution.status, t);
          setPageStatus(resolved.pageStatus);
          if (resolved.error) setExecError(data.execution.error || resolved.error);
          if (data.execution.result) setResult(data.execution.result);
        } else if (data.consumed) {
          // Consumed but no execution yet — invalid
          setPageStatus("invalid");
        } else {
          setPageStatus("idle");
        }
      })
      .catch(() => setPageStatus("invalid"));
  }, [token, t]);

  // Polling for execution status + logs
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

      // Update logs
      if (data.logs) setRawLogs(data.logs as RawLog[]);

      const resolved = resolveExecutionStatus(data.status as string, t);
      if (resolved.pageStatus !== "running") {
        setPageStatus(resolved.pageStatus);
        if (resolved.error) setExecError(data.error || resolved.error);
        if (data.result) setResult(data.result as Record<string, unknown>);
        stopPolling();
      }
    } catch {
      // Ignore polling errors
    }
  }, [token, stopPolling, t]);

  const startPolling = useCallback(() => {
    stopPolling();
    poll();
    pollRef.current = setInterval(poll, POLL_INTERVAL_MS);
  }, [poll, stopPolling]);

  // Start polling when entering "running" state
  useEffect(() => {
    if (pageStatus === "running") {
      startPolling();
    }
    return stopPolling;
  }, [pageStatus, startPolling, stopPolling]);

  const [submitting, setSubmitting] = useState(false);

  const handleRun = async () => {
    if (!token) return;
    setExecError(null);
    setSubmitting(true);

    try {
      const input = schema ? buildInputPayload(schema, mergedInputValues) : undefined;
      const hasFiles = Object.values(fileValues).some((f) => f.length > 0);

      let res: Response;
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
          setPageStatus("invalid");
          return;
        }
        // Validation error — stay on form and show error
        setExecError(err.message || `Error ${res.status}`);
        return;
      }

      await res.json();
      // Execution started — switch to running state
      setResult(null);
      setRawLogs([]);
      setPageStatus("running");
    } catch (err) {
      setExecError(err instanceof Error ? err.message : t("error.unknown"));
    } finally {
      setSubmitting(false);
    }
  };

  if (pageStatus === "loading") {
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

  if (pageStatus === "invalid") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="w-full max-w-lg rounded-lg border border-border bg-card p-6 shadow-lg">
          <div className="mb-4">
            <h2 className="text-lg font-semibold">{t("public.invalidTitle")}</h2>
          </div>
          <div className="rounded-md bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {t("public.invalidMessage")}
          </div>
        </div>
      </div>
    );
  }

  if (!flowInfo) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="w-full max-w-lg rounded-lg border border-border bg-card p-6 shadow-lg">
          <div className="rounded-md bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {t("public.notFound")}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-lg rounded-lg border border-border bg-card p-6 shadow-lg">
        <div className="mb-4">
          <h2 className="text-lg font-semibold">{flowInfo.displayName}</h2>
          {flowInfo.description && (
            <p className="text-sm text-muted-foreground mt-1">{flowInfo.description}</p>
          )}
        </div>

        {flowInfo.providers && flowInfo.providers.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-4">
            {flowInfo.providers.map((svc) => {
              const isConnected = svc.status === "connected";
              if (svc.connectionMode === "admin" && svc.adminProvided) {
                return (
                  <div
                    key={svc.id}
                    className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm"
                    title={svc.description}
                  >
                    <span className="h-2 w-2 rounded-full bg-success inline-block" />
                    {svc.id}
                    <span className="ml-1 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                      {t("admin")}
                    </span>
                  </div>
                );
              }
              if (svc.connectionMode === "admin") {
                return (
                  <div
                    key={svc.id}
                    className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm"
                    title={svc.description}
                  >
                    <span className="h-2 w-2 rounded-full bg-destructive inline-block" />
                    {svc.id}
                    <span className="ml-1 rounded bg-warning/10 px-1.5 py-0.5 text-xs text-warning">
                      {t("detail.pending")}
                    </span>
                  </div>
                );
              }
              return (
                <div
                  key={svc.id}
                  className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm"
                  title={svc.description}
                >
                  <span
                    className={cn(
                      "h-2 w-2 rounded-full inline-block",
                      isConnected ? "bg-success" : "bg-destructive",
                    )}
                  />
                  {svc.id}
                </div>
              );
            })}
          </div>
        )}

        {pageStatus === "idle" && (
          <div className="space-y-4">
            {execError && (
              <div className="rounded-md bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {execError}
              </div>
            )}
            {hasInput && (
              <InputFields
                schema={schema!}
                values={mergedInputValues}
                onChange={(key, value) => setInputValues((prev) => ({ ...prev, [key]: value }))}
                fileValues={fileValues}
                onFileChange={(key, files) => setFileValues((prev) => ({ ...prev, [key]: files }))}
                idPrefix="public-input"
              />
            )}
            <Button className="w-full" onClick={handleRun} disabled={submitting}>
              {submitting ? <Spinner /> : t("shareable.execute")}
            </Button>
          </div>
        )}

        {pageStatus === "running" && <ExecutionTimeline entries={logEntries} isRunning />}

        {(pageStatus === "success" || pageStatus === "failed" || pageStatus === "timeout") && (
          <div className="space-y-4">
            {logEntries.length > 0 && <ExecutionTimeline entries={logEntries} />}
            {execError && (
              <div className="rounded-md bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {execError}
              </div>
            )}
            {result && <ResultRenderer data={result} outputSchema={flowInfo.output?.schema} />}
          </div>
        )}
      </div>
    </div>
  );
}
