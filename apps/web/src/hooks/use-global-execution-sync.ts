import { useEffect, useRef } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCurrentOrgId } from "./use-org";
import type { Execution } from "@appstrate/shared-types";

const TERMINAL_STATUSES = new Set(["success", "failed", "timeout", "cancelled"]);

function handleSSEMessage(qc: QueryClient, orgId: string, raw: string) {
  try {
    const newRow = JSON.parse(raw) as Record<string, unknown>;
    const packageId = newRow.packageId as string;
    const execId = newRow.id as string;
    const status = newRow.status as string;

    qc.setQueryData<Execution>(["execution", orgId, execId], (prev) => {
      if (!prev) return prev;
      return { ...prev, ...newRow } as Execution;
    });

    qc.setQueryData<Execution[]>(["executions", orgId, packageId], (prev) => {
      if (!prev) return prev;
      const exists = prev.some((ex) => ex.id === execId);
      if (exists) {
        return prev.map((ex) => (ex.id === execId ? ({ ...ex, ...newRow } as Execution) : ex));
      }
      return [newRow as Execution, ...prev].slice(0, 50);
    });

    qc.invalidateQueries({ queryKey: ["flows", orgId] });
    qc.invalidateQueries({ queryKey: ["packages", "flow", orgId, packageId] });
    qc.invalidateQueries({ queryKey: ["all-executions"] });

    if (TERMINAL_STATUSES.has(status)) {
      qc.invalidateQueries({ queryKey: ["execution", orgId, execId] });
      qc.invalidateQueries({ queryKey: ["unread-count", orgId] });
      qc.invalidateQueries({ queryKey: ["billing", orgId] });
    }
  } catch {
    // Ignore malformed payloads
  }
}

/**
 * Global SSE subscription on execution changes.
 * Uses fetch + ReadableStream instead of EventSource to avoid
 * Safari's aggressive auto-reconnect behavior on connection failure.
 */
export function useGlobalExecutionSync() {
  const qc = useQueryClient();
  const orgId = useCurrentOrgId();
  const qcRef = useRef(qc);
  qcRef.current = qc;

  useEffect(() => {
    if (!orgId) return;

    const controller = new AbortController();

    (async () => {
      try {
        const res = await fetch(
          `/api/realtime/executions?orgId=${encodeURIComponent(orgId)}&verbose=true`,
          {
            credentials: "include",
            signal: controller.signal,
          },
        );
        if (!res.ok || !res.body) return;

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;

          buf += decoder.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop()!;

          for (const part of parts) {
            let event = "";
            let data = "";
            for (const line of part.split("\n")) {
              if (line.startsWith("event:")) event = line.slice(6).trim();
              else if (line.startsWith("data:")) data = line.slice(5).trim();
            }
            if (event === "execution_update" && data) {
              handleSSEMessage(qcRef.current, orgId, data);
            }
          }
        }
      } catch {
        // Connection failed or aborted — no auto-reconnect
      }
    })();

    return () => controller.abort();
  }, [orgId]);
}
