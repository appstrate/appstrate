// SPDX-License-Identifier: Apache-2.0

/**
 * In-chat run panel. Rendered when the assistant launches a run (the
 * `runAgent` / `runInline` / `run_and_wait` tool result carries a `run_…` id):
 * shows the launch card (passed in as `header`) plus a live, auto-scrolling
 * log tail streamed from the run's SSE channel via `useRunLogStream`.
 *
 * The panel is purely additive — if org/app context or SSE is unavailable the
 * log section simply stays empty and the header card behaves exactly as before.
 */

import * as React from "react";
import { Loader2Icon, TerminalIcon } from "lucide-react";
import { useRunLogStream } from "./use-run-log-stream.ts";
import { isTerminalStatus, type RunLogLine, type RunStatus } from "./run-events.ts";

const LEVEL_TONE: Record<string, string> = {
  debug: "text-muted-foreground",
  info: "text-foreground",
  warn: "text-amber-600 dark:text-amber-400",
  error: "text-destructive",
};

const STATUS_LABEL: Record<RunStatus, string> = {
  pending: "En attente",
  running: "En cours",
  success: "Terminé",
  failed: "Échec",
  timeout: "Expiré",
  cancelled: "Annulé",
};

/** One log row — prefers `message`, falls back to `event`, then compact `data`. */
function LogRow({ line }: { line: RunLogLine }) {
  const tone = LEVEL_TONE[line.level ?? "info"] ?? "text-foreground";
  const text =
    line.message ??
    line.event ??
    (typeof line.data === "string" ? line.data : line.data ? JSON.stringify(line.data) : "");
  if (!text) return null;
  return (
    <div className={`break-words whitespace-pre-wrap ${tone}`}>
      <span className="text-muted-foreground/60 select-none">{line.level ?? "info"} </span>
      {text}
    </div>
  );
}

export function RunPanel({
  runId,
  initialStatus,
  header,
}: {
  runId: string;
  initialStatus?: string;
  header: React.ReactNode;
}) {
  const { logs, status, live } = useRunLogStream(runId, initialStatus);
  const effectiveStatus =
    status ?? (isTerminalStatus(initialStatus) ? (initialStatus as RunStatus) : undefined);

  // Auto-scroll the log viewport to the bottom as new lines stream in, unless
  // the user has scrolled up to read history.
  const viewportRef = React.useRef<HTMLDivElement>(null);
  const pinnedRef = React.useRef(true);
  React.useEffect(() => {
    const el = viewportRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [logs]);

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  return (
    <div className="space-y-1">
      {header}
      {logs.length > 0 || live ? (
        <div className="bg-muted/30 text-muted-foreground rounded-lg border text-xs">
          <div className="flex items-center gap-2 border-b px-3 py-1.5">
            <TerminalIcon className="size-3.5 shrink-0" />
            <span className="font-medium">Logs</span>
            {effectiveStatus ? (
              <span className="text-muted-foreground/80">· {STATUS_LABEL[effectiveStatus]}</span>
            ) : null}
            {live ? <Loader2Icon className="size-3 shrink-0 animate-spin" /> : null}
            <span className="text-muted-foreground/50 ml-auto tabular-nums">{logs.length}</span>
          </div>
          {logs.length > 0 ? (
            <div
              ref={viewportRef}
              onScroll={onScroll}
              className="max-h-64 overflow-y-auto px-3 py-2 font-mono leading-relaxed"
            >
              {logs.map((line) => (
                <LogRow key={line.id} line={line} />
              ))}
            </div>
          ) : (
            <div className="px-3 py-2 font-mono">En attente des premiers logs…</div>
          )}
        </div>
      ) : null}
    </div>
  );
}
