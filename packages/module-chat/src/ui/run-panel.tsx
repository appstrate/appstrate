// SPDX-License-Identifier: Apache-2.0

/**
 * In-chat run panel. Rendered for every run-launch tool-call (`runAgent` /
 * `runInline` / `run_and_wait`) — from the moment it starts, before the run id
 * is even known — so the card keeps a constant two-line height with no
 * transient "Lancement…" placeholder swap.
 *
 * Line 1: the package name. Line 2: the run's own log-tool output (rows the sink
 * tags `event='log'`, i.e. the agent's explicit `log` runtime tool — NOT runtime
 * lifecycle or tool-call breadcrumbs), streamed live over the run's SSE channel
 * (`useRunLogStream`) and paced one at a time (`useLogTicker`, ≥500ms each) with
 * a fade/slide animation so a burst reads as a sequence rather than a flash. A
 * live status badge and a link to the run's page sit on the right. Clicking the
 * card opens the raw input/output detail modal (`details`).
 *
 * Before the launch returns a `run_…` id (e.g. `run_and_wait` still blocking)
 * there is no SSE yet: the badge falls back to the tool-call phase and line 2
 * shows a placeholder — same height throughout.
 */

import * as React from "react";
import {
  AlertTriangleIcon,
  CheckIcon,
  ExternalLinkIcon,
  Loader2Icon,
  PlayIcon,
} from "lucide-react";
import { Modal } from "./modal.tsx";
import { useRunLogStream } from "./use-run-log-stream.ts";
import { useLogTicker } from "./use-log-ticker.ts";
import { isTerminalStatus, visibleLogEntries, type RunStatus } from "./run-events.ts";
import type { ToolPhase } from "./tool-result.ts";

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

/**
 * Status badge. Prefers the run's real status (from SSE / launch result); until
 * that exists it falls back to the tool-call phase so a just-started run still
 * shows a spinner ("En cours") or an error state rather than nothing.
 */
function StatusBadge({ status, phase }: { status: RunStatus | undefined; phase: ToolPhase }) {
  if (status) {
    const terminal = isTerminalStatus(status);
    return (
      <span
        className={`flex shrink-0 items-center gap-1 text-xs font-medium ${STATUS_TONE[status]}`}
      >
        {!terminal ? (
          <Loader2Icon className="size-3 animate-spin" />
        ) : status === "success" ? (
          <CheckIcon className="size-3" />
        ) : (
          <AlertTriangleIcon className="size-3" />
        )}
        {STATUS_LABEL[status]}
      </span>
    );
  }
  if (phase === "error") {
    return (
      <span className="text-destructive flex shrink-0 items-center gap-1 text-xs font-medium">
        <AlertTriangleIcon className="size-3" />
        Échec
      </span>
    );
  }
  return (
    <span className="text-muted-foreground flex shrink-0 items-center gap-1 text-xs font-medium">
      <Loader2Icon className="size-3 animate-spin" />
      En cours
    </span>
  );
}

export function RunPanel({
  runId,
  initialStatus,
  agentLabel,
  runHref,
  phase,
  modalTitle,
  details,
}: {
  runId: string | undefined;
  initialStatus?: string;
  agentLabel?: string;
  runHref?: string;
  phase: ToolPhase;
  modalTitle: React.ReactNode;
  details: React.ReactNode;
}) {
  const { logs, status } = useRunLogStream(runId, initialStatus);
  const effectiveStatus =
    status ?? (isTerminalStatus(initialStatus) ? (initialStatus as RunStatus) : undefined);
  const [open, setOpen] = React.useState(false);

  // Pace the log line: a burst of lines plays back one at a time (≥500ms each)
  // rather than flashing straight to the last one. `current` carries a stable
  // `id` so the line element remounts on change and re-runs its enter animation.
  const current = useLogTicker(visibleLogEntries(logs));
  const placeholder = effectiveStatus === "pending" ? "Démarrage du run…" : "En attente des logs…";

  return (
    <div className="bg-card text-card-foreground relative my-3 w-full rounded-lg border">
      {/* Full-card click target (opens the detail modal). Behind the content so
          the run-page link can re-enable pointer events for itself — avoids
          nesting interactive elements. */}
      <button
        type="button"
        aria-label="Détails du run"
        className="hover:bg-muted/40 absolute inset-0 z-0 rounded-lg"
        onClick={() => setOpen(true)}
      />
      <div className="pointer-events-none relative z-10 flex items-start gap-2 px-3 py-2">
        <PlayIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {/* Line 1: package name + live status + run-page link */}
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{agentLabel ?? "Run"}</span>
            <span className="ml-auto flex shrink-0 items-center gap-2">
              <StatusBadge status={effectiveStatus} phase={phase} />
              {runHref ? (
                <a
                  href={runHref}
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
            {current ? (
              <span
                key={current.id}
                className="text-muted-foreground animate-in fade-in slide-in-from-bottom-1 col-start-1 row-start-1 truncate duration-300"
              >
                {current.text}
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
