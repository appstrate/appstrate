// SPDX-License-Identifier: Apache-2.0

/**
 * In-chat run panel. Rendered when the assistant launches a run (the
 * `runAgent` / `runInline` / `run_and_wait` tool result carries a `run_…` id).
 *
 * A compact two-line card: line 1 is the agent name + a live status badge + a
 * link to the run's page; line 2 is the latest log line (debug excluded), both
 * updating in real time from the run's SSE channel (`useRunLogStream`). Clicking
 * the card opens the raw input/output detail modal (`details`). No accordion.
 *
 * Purely additive: with no org/app context or SSE the card still shows the
 * status from the launch result and degrades gracefully.
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
import { isTerminalStatus, lastVisibleLogText, type RunStatus } from "./run-events.ts";

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

export function RunPanel({
  runId,
  initialStatus,
  agentLabel,
  runHref,
  modalTitle,
  details,
}: {
  runId: string;
  initialStatus?: string;
  agentLabel?: string;
  runHref?: string;
  modalTitle: React.ReactNode;
  details: React.ReactNode;
}) {
  const { logs, status, live } = useRunLogStream(runId, initialStatus);
  const effectiveStatus =
    status ?? (isTerminalStatus(initialStatus) ? (initialStatus as RunStatus) : undefined);
  const [open, setOpen] = React.useState(false);

  const latest = lastVisibleLogText(logs);
  const secondLine =
    latest ??
    (effectiveStatus === "pending"
      ? "Démarrage du run…"
      : live
        ? "En attente des premiers logs…"
        : runId);

  return (
    <div className="bg-card text-card-foreground relative my-3 w-full rounded-lg border">
      {/* Full-card click target (opens the detail modal). Kept behind the content
          so the run-page link can re-enable pointer events for itself — avoids
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
          {/* Line 1: agent name + live status + run-page link */}
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{agentLabel ?? "Run"}</span>
            <span className="ml-auto flex shrink-0 items-center gap-2">
              <StatusBadge status={effectiveStatus} live={live} />
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
          {/* Line 2: latest non-debug log line */}
          <div className="text-muted-foreground truncate font-mono text-xs">{secondLine}</div>
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
