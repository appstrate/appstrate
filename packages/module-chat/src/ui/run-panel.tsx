// SPDX-License-Identifier: Apache-2.0

/**
 * In-chat run panel. Rendered when the assistant launches a run (the
 * `runAgent` / `runInline` / `run_and_wait` tool result carries a `run_…` id).
 *
 * Shows a compact two-line summary block — agent name + live status on line 1,
 * the latest log line on line 2 — that updates in real time from the run's SSE
 * channel (`useRunLogStream`). A "détails" toggle expands the full scrolling log
 * tail and the raw tool-call card (`header`).
 *
 * Purely additive: with no org/app context or SSE the summary still shows the
 * status from the launch result and the panel degrades gracefully.
 */

import * as React from "react";
import {
  AlertTriangleIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  Loader2Icon,
  PlayIcon,
} from "lucide-react";
import { useRunLogStream } from "./use-run-log-stream.ts";
import {
  isTerminalStatus,
  lastLogText,
  logLineText,
  type RunLogLine,
  type RunStatus,
} from "./run-events.ts";

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

const STATUS_TONE: Record<RunStatus, string> = {
  pending: "text-muted-foreground",
  running: "text-blue-600 dark:text-blue-400",
  success: "text-emerald-600 dark:text-emerald-400",
  failed: "text-destructive",
  timeout: "text-amber-600 dark:text-amber-400",
  cancelled: "text-muted-foreground",
};

/** Status indicator: spinner while live/pending, check on success, warn otherwise. */
function StatusBadge({ status, live }: { status: RunStatus | undefined; live: boolean }) {
  const label = status ? STATUS_LABEL[status] : live ? "En cours" : "—";
  const tone = status ? STATUS_TONE[status] : "text-muted-foreground";
  const terminal = isTerminalStatus(status);
  return (
    <span className={`flex shrink-0 items-center gap-1 text-xs font-medium ${tone}`}>
      {!terminal && (live || status === "running" || status === "pending") ? (
        <Loader2Icon className="size-3 animate-spin" />
      ) : status === "success" ? (
        <CheckIcon className="size-3" />
      ) : terminal ? (
        <AlertTriangleIcon className="size-3" />
      ) : null}
      {label}
    </span>
  );
}

/** One log row in the expanded viewport. */
function LogRow({ line }: { line: RunLogLine }) {
  const tone = LEVEL_TONE[line.level ?? "info"] ?? "text-foreground";
  const text = logLineText(line);
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
  agentLabel,
  header,
}: {
  runId: string;
  initialStatus?: string;
  agentLabel?: string;
  header?: React.ReactNode;
}) {
  const { logs, status, live } = useRunLogStream(runId, initialStatus);
  const effectiveStatus =
    status ?? (isTerminalStatus(initialStatus) ? (initialStatus as RunStatus) : undefined);
  const [expanded, setExpanded] = React.useState(false);

  const latest = lastLogText(logs);
  const secondLine =
    latest ??
    (effectiveStatus === "pending"
      ? "Démarrage du run…"
      : live
        ? "En attente des premiers logs…"
        : `Run ${runId}`);

  // Auto-scroll the expanded viewport as lines stream in, unless scrolled up.
  const viewportRef = React.useRef<HTMLDivElement>(null);
  const pinnedRef = React.useRef(true);
  React.useEffect(() => {
    const el = viewportRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [logs, expanded]);

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  return (
    <div className="bg-card text-card-foreground my-3 w-full rounded-lg border">
      {/* Two-line summary block */}
      <div className="flex items-start gap-2 px-3 py-2">
        <PlayIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {/* Line 1: agent name + live status */}
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{agentLabel ?? "Run"}</span>
            <code className="text-muted-foreground/70 hidden truncate text-xs sm:inline">
              {runId}
            </code>
            <span className="ml-auto flex items-center gap-2">
              {logs.length > 0 ? (
                <span className="text-muted-foreground/50 text-xs tabular-nums">
                  {logs.length} logs
                </span>
              ) : null}
              <StatusBadge status={effectiveStatus} live={live} />
            </span>
          </div>
          {/* Line 2: latest log line */}
          <div className="text-muted-foreground truncate font-mono text-xs">{secondLine}</div>
        </div>
      </div>

      {/* Details toggle + expanded content */}
      {logs.length > 0 || header ? (
        <div className="border-t">
          <button
            type="button"
            className="hover:bg-muted/40 text-muted-foreground flex w-full items-center gap-1 px-3 py-1.5 text-left text-xs"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? (
              <ChevronDownIcon className="size-3.5" />
            ) : (
              <ChevronRightIcon className="size-3.5" />
            )}
            Détails
          </button>
          {expanded ? (
            <div className="space-y-2 px-3 pb-3">
              {logs.length > 0 ? (
                <div
                  ref={viewportRef}
                  onScroll={onScroll}
                  className="bg-muted/30 max-h-64 overflow-y-auto rounded-md p-2 font-mono text-xs leading-relaxed"
                >
                  {logs.map((line) => (
                    <LogRow key={line.id} line={line} />
                  ))}
                </div>
              ) : null}
              {header}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
