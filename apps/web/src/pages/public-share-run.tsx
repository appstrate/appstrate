import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useParams } from "react-router-dom";
import type { JSONSchemaObject } from "@appstrate/shared-types";
import { InputFields } from "../components/input-fields";
import { initInputValues, buildInputPayload } from "../components/input-utils";
import { ResultRenderer } from "../components/result-renderer";
import { Spinner } from "../components/spinner";

type PageStatus = "loading" | "idle" | "running" | "success" | "failed" | "timeout" | "invalid";

interface FlowInfo {
  displayName: string;
  description?: string;
  input?: { schema: JSONSchemaObject };
  consumed: boolean;
  execution?: {
    id: string;
    status: string;
    result?: Record<string, unknown>;
    error?: string;
  };
}

const POLL_INTERVAL_MS = 2000;

function resolveExecutionStatus(status: string): {
  pageStatus: PageStatus;
  error: string | null;
} {
  switch (status) {
    case "success":
      return { pageStatus: "success", error: null };
    case "failed":
      return { pageStatus: "failed", error: "L'execution a echoue." };
    case "timeout":
      return { pageStatus: "timeout", error: "L'execution a expire (timeout)." };
    default:
      return { pageStatus: "running", error: null };
  }
}

export function PublicShareRunPage() {
  const { token } = useParams<{ token: string }>();
  const [pageStatus, setPageStatus] = useState<PageStatus>("loading");
  const [flowInfo, setFlowInfo] = useState<FlowInfo | null>(null);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [execError, setExecError] = useState<string | null>(null);
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
          const resolved = resolveExecutionStatus(data.execution.status);
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
  }, [token]);

  // Polling for execution status
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

      const resolved = resolveExecutionStatus(data.status as string);
      if (resolved.pageStatus !== "running") {
        setPageStatus(resolved.pageStatus);
        if (resolved.error) setExecError(data.error || resolved.error);
        if (data.result) setResult(data.result as Record<string, unknown>);
        stopPolling();
      }
    } catch {
      // Ignore polling errors
    }
  }, [token, stopPolling]);

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

  const handleRun = async () => {
    if (!token) return;
    setPageStatus("running");
    setResult(null);
    setExecError(null);

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
        throw new Error(err.message || `Erreur ${res.status}`);
      }

      await res.json();
      // Polling will start via the useEffect on pageStatus === "running"
    } catch (err) {
      setPageStatus("failed");
      setExecError(err instanceof Error ? err.message : "Erreur inconnue");
    }
  };

  if (pageStatus === "loading") {
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

  if (pageStatus === "invalid") {
    return (
      <div className="shareable-run">
        <div className="shareable-run-card">
          <div className="shareable-run-header">
            <h2>Lien invalide</h2>
          </div>
          <div className="exec-error">
            Ce lien n'est plus valide. Il a peut-etre deja ete utilise ou a expire.
          </div>
        </div>
      </div>
    );
  }

  if (!flowInfo) {
    return (
      <div className="shareable-run">
        <div className="shareable-run-card">
          <div className="exec-error">Flow introuvable.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="shareable-run">
      <div className="shareable-run-card">
        <div className="shareable-run-header">
          <h2>{flowInfo.displayName}</h2>
          {flowInfo.description && <p className="description">{flowInfo.description}</p>}
        </div>

        {pageStatus === "idle" && (
          <div className="shareable-run-form">
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
            <button className="primary shareable-run-btn" onClick={handleRun}>
              Executer
            </button>
          </div>
        )}

        {pageStatus === "running" && (
          <div className="shareable-run-status">
            <Spinner />
            <span>Execution en cours...</span>
          </div>
        )}

        {(pageStatus === "success" || pageStatus === "failed" || pageStatus === "timeout") && (
          <div className="shareable-run-result">
            {execError && <div className="exec-error">{execError}</div>}
            {result && <ResultRenderer data={result} outputSchema={flowInfo.input?.schema} />}
          </div>
        )}
      </div>
    </div>
  );
}
