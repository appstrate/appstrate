// SPDX-License-Identifier: Apache-2.0

/**
 * In-chat run progress component. Rendered for every run-launch tool-call (`runAgent` /
 * `runInline` / `run_and_wait`) — from the moment it starts, before the run id
 * is even known — so the card keeps a constant two-line height with no
 * transient "Lancement…" placeholder swap.
 *
 * Line 1: the package name. Line 2: the run's own log-tool output (rows the sink
 * tags `event='log'`, i.e. the agent's explicit `log` runtime tool — NOT runtime
 * lifecycle or tool-call breadcrumbs), streamed live over the run's SSE channel
 * (`useRunLogStream`) and paced one at a time (`useLogTicker`, ≥500ms each) with
 * a fade/slide animation so a burst reads as a sequence rather than a flash.
 * Before the first log the line reads "Lancement" (still starting), then
 * "Exécution en cours" once running; once terminal it settles on the final outcome. A
 * leading status glyph (centered across both lines) shows the run state; the
 * live execution time and a link to the run's page sit on the right. Clicking
 * the card opens the raw input/output detail modal (`details`).
 *
 * Before the tool returns a `run_…` id there is no SSE yet: status glyph falls back to the tool-call phase.
 */

import * as React from "react";
import { AlertTriangleIcon, CheckIcon, ExternalLinkIcon, Loader2Icon } from "lucide-react";
import { Modal } from "./modal.tsx";
import { useRunLogStream } from "./use-run-log-stream.ts";
import { useLogTicker } from "./use-log-ticker.ts";
import { formatDuration } from "@appstrate/core/format";
import { useLiveElapsedMs } from "./use-elapsed.ts";
import {
  buildRunPageHref,
  isTerminalStatus,
  terminalRunLineText,
  visibleLogEntries,
  type RunStatus,
} from "./run-events.ts";
import type { ToolPhase } from "./tool-result.ts";

const STATUS_TONE: Record<RunStatus, string> = {
  pending: "text-muted-foreground",
  running: "text-blue-600 dark:text-blue-400",
  success: "text-emerald-600 dark:text-emerald-400",
  failed: "text-destructive",
  timeout: "text-amber-600 dark:text-amber-400",
  cancelled: "text-muted-foreground",
};

/**
 * Leading status glyph (no label — the icon IS the status). Prefers the run's
 * real status (SSE / launch result); until that exists it falls back to the
 * tool-call phase so a just-started run still shows a spinner (or an error
 * state) rather than nothing. A non-terminal run spins; success shows a check;
 * any other terminal state shows a warning triangle.
 */
function StatusIcon({ status, phase }: { status: RunStatus | undefined; phase: ToolPhase }) {
  if (status) {
    if (!isTerminalStatus(status)) {
      return <Loader2Icon className={`size-4 shrink-0 animate-spin ${STATUS_TONE[status]}`} />;
    }
    if (status === "success") {
      return <CheckIcon className={`size-4 shrink-0 ${STATUS_TONE[status]}`} />;
    }
    return <AlertTriangleIcon className={`size-4 shrink-0 ${STATUS_TONE[status]}`} />;
  }
  if (phase === "error") {
    return <AlertTriangleIcon className="text-destructive size-4 shrink-0" />;
  }
  return <Loader2Icon className="text-muted-foreground size-4 shrink-0 animate-spin" />;
}

export function ChatRunProgressCard({
  runId,
  initialStatus,
  agentLabel,
  runHref,
  initialPackageId,
  phase,
  modalTitle,
  details,
}: {
  runId: string | undefined;
  initialStatus?: string;
  agentLabel?: string;
  runHref?: string;
  initialPackageId?: string;
  phase: ToolPhase;
  modalTitle: React.ReactNode;
  details: React.ReactNode;
}) {
  const { logs, status, packageId, startedAt, completedAt, duration } = useRunLogStream(
    runId,
    initialStatus,
    initialPackageId,
  );
  const effectiveStatus =
    status ?? (isTerminalStatus(initialStatus) ? (initialStatus as RunStatus) : undefined);
  const [open, setOpen] = React.useState(false);

  // Live execution time — ticks while running, then settles on the
  // server-authoritative `runs.duration` (same value the run page shows).
  // The local `completedAt - startedAt` fallback covers frames that predate
  // the duration column being populated.
  const liveElapsedMs = useLiveElapsedMs(startedAt, completedAt);
  const elapsedMs = duration ?? liveElapsedMs;

  // Pace the log line: a burst of lines plays back one at a time (≥500ms each)
  // rather than flashing straight to the last one. `current` carries a stable
  // `id` so the line element remounts on change and re-runs its enter animation.
  const current = useLogTicker(visibleLogEntries(logs));
  // Before any log line: "Lancement" while the run is still starting (no status
  // yet, or pending), then "Exécution en cours" once it is running — up until the
  // first log replaces it.
  const placeholder = effectiveStatus === "running" ? "Exécution en cours" : "Lancement";

  // Once the run is terminal, the live log line is replaced by a fixed status
  // label so the card settles on the actual outcome instead of freezing on
  // whatever the last log happened to be. A stable key (-1) lets it animate in.
  const terminal = isTerminalStatus(effectiveStatus);
  const line = terminal ? { id: -1, text: terminalRunLineText(effectiveStatus) } : current;
  const effectiveRunHref = runHref ?? (runId ? buildRunPageHref(packageId, runId) : undefined);

  // `isolate` scopes the internal z-0/z-10 layering to this card — without it
  // the z-10 content escapes into the thread's stacking context and paints
  // over the sticky composer when the card scrolls behind it.
  return (
    <div className="bg-card text-card-foreground relative isolate my-3 w-full rounded-lg border">
      {/* Full-card click target (opens the detail modal). Behind the content so
          the run-page link can re-enable pointer events for itself — avoids
          nesting interactive elements. */}
      <button
        type="button"
        aria-label="Détails du run"
        className="hover:bg-muted/40 absolute inset-0 z-0 rounded-lg"
        onClick={() => setOpen(true)}
      />
      <div className="pointer-events-none relative z-10 flex items-center gap-2 px-3 py-2">
        {/* Leading status glyph — vertically centered across the two lines. */}
        <StatusIcon status={effectiveStatus} phase={phase} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {/* Line 1: package name + live execution time + run-page link */}
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{agentLabel ?? "Run"}</span>
            <span className="ml-auto flex shrink-0 items-center gap-2">
              {elapsedMs !== undefined ? (
                <span className="text-muted-foreground text-xs tabular-nums">
                  {formatDuration(elapsedMs)}
                </span>
              ) : null}
              {effectiveRunHref ? (
                <a
                  href={effectiveRunHref}
                  className="text-muted-foreground hover:text-foreground pointer-events-auto"
                  title="Ouvrir la page du run"
                  onClick={(e) => e.stopPropagation()}
                >
                  <ExternalLinkIcon className="size-3.5" />
                </a>
              ) : null}
            </span>
          </div>
          {/* Line 2: paced log-tool line (constant height). Keyed by log id
              so each new line remounts and runs the fade/slide enter animation;
              `grid` keeps the row height fixed while the line swaps. */}
          <div className="grid font-mono text-xs">
            {line ? (
              <span
                key={line.id}
                className="text-muted-foreground animate-in fade-in slide-in-from-bottom-1 col-start-1 row-start-1 truncate duration-300"
              >
                {line.text}
              </span>
            ) : (
              <span className="text-muted-foreground col-start-1 row-start-1 truncate">
                {placeholder}
              </span>
            )}
          </div>
        </div>
      </div>

      {open ? (
        <Modal title={modalTitle} onClose={() => setOpen(false)}>
          {details}
        </Modal>
      ) : null}
    </div>
  );
}
