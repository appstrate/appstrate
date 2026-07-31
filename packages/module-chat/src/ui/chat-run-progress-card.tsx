// SPDX-License-Identifier: Apache-2.0

/**
 * In-chat run progress component. Rendered for every run-launch tool-call (`runAgent` /
 * `runInline` / `run_and_wait`) — from the moment it starts, before the run id
 * is even known — so the card keeps a constant two-line height with no
 * transient placeholder swap.
 *
 * Line 1: the package name. Line 2: the run's own log-tool output (rows the sink
 * tags `event='log'`, i.e. the agent's explicit `log` runtime tool — NOT runtime
 * lifecycle or tool-call breadcrumbs), streamed live over the run's SSE channel
 * (`useRunLogStream`) and paced one at a time (`useLogTicker`, ≥500ms each) with
 * a fade/slide animation so a burst reads as a sequence rather than a flash.
 * Before the first log the line reads `run.starting` (still starting), then
 * `run.running` once running; once terminal it settles on the final outcome. A
 * leading status glyph (centered across both lines) shows the run state; the
 * live execution time and a link to the run's page sit on the right. Clicking
 * the card opens the raw input/output detail modal (`details`).
 *
 * Before the tool returns a `run_…` id there is no SSE yet: status glyph falls back to the tool-call phase.
 *
 * A launch failure (tool errored before a run id exists) renders INSIDE this
 * card — error glyph + `errorText` on line 2 — never as a swap to another
 * component, so the block's height stays constant for the call's whole life.
 */

import * as React from "react";
import { AlertTriangleIcon, CheckIcon, ExternalLinkIcon, Loader2Icon } from "lucide-react";
import { Modal } from "./modal.tsx";
import { useRunLogStream } from "./use-run-log-stream.ts";
import { useLogTicker } from "./use-log-ticker.ts";
import { formatDuration } from "@appstrate/core/format";
import { useLiveElapsedMs } from "./use-elapsed.ts";
import { useChatHost } from "./runtime-context.ts";
import {
  buildRunPageHref,
  isPrimaryAutoPresentationEligible,
  isTerminalStatus,
  mergeRunDocuments,
  primaryDocumentFromLogs,
  publishedDocumentsFromLogs,
  runStatusLineKey,
  visibleLogEntries,
  type ChatRunDocument,
  type RunStatus,
} from "./run-events.ts";
import { DocumentAttachment } from "./document-attachment.tsx";
import type { ToolPhase } from "./tool-result.ts";

/**
 * Row of document attachments surfaced under a run card — the same unified
 * renderer the thread uses for sent attachments: an image shows a square
 * thumbnail, anything else a chip. With a host opener (web shell) it opens the
 * in-app preview; without one (embedded mounts) it falls back to the
 * authenticated download.
 */
function DocumentChips({
  documents,
  primaryDocumentId,
}: {
  documents: ChatRunDocument[];
  primaryDocumentId: string | null | undefined;
}) {
  const { t } = useChatHost();
  if (documents.length === 0) return null;
  const ordered = primaryDocumentId
    ? [...documents].sort(
        (a, b) => Number(b.id === primaryDocumentId) - Number(a.id === primaryDocumentId),
      )
    : documents;
  return (
    <div className="pointer-events-auto flex flex-wrap gap-1.5 px-3 pb-2">
      {ordered.map((doc) => (
        <div key={doc.id} className="flex min-w-0 items-center gap-1.5">
          <DocumentAttachment doc={{ id: doc.id, name: doc.name, mime: doc.mime }} />
          {doc.id === primaryDocumentId ? (
            <span className="bg-primary/10 text-primary shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium">
              {t("doc.primary")}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

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
  initialDocuments,
  phase,
  errorText,
  modalTitle,
  details,
}: {
  runId: string | undefined;
  initialStatus?: string;
  agentLabel?: string;
  runHref?: string;
  initialPackageId?: string;
  /** Documents from the persisted tool result — survive reload; merged with live ones. */
  initialDocuments?: ChatRunDocument[];
  phase: ToolPhase;
  /** Launch-failure message shown on line 2 when the tool errored without a run id. */
  errorText?: string;
  modalTitle: React.ReactNode;
  details: React.ReactNode;
}) {
  const {
    logs,
    status,
    packageId,
    startedAt,
    completedAt,
    duration,
    primaryDocumentId: authoritativePrimaryDocumentId,
  } = useRunLogStream(runId, initialStatus, initialPackageId);

  // Documents: the persisted tool-result list (reload-safe) merged with any
  // that arrive live over the log stream (`document.published` frames).
  const documents = React.useMemo(
    () => mergeRunDocuments(initialDocuments ?? [], publishedDocumentsFromLogs(logs)),
    [initialDocuments, logs],
  );
  const loggedPrimaryDocument = React.useMemo(() => primaryDocumentFromLogs(logs), [logs]);
  // `undefined` means the run resource has not answered yet, so the latest log
  // is a useful fallback. `null` is authoritative and deliberately suppresses
  // stale historical primary events (deleted/expired/detached output).
  const primaryDocumentId =
    authoritativePrimaryDocumentId === undefined
      ? loggedPrimaryDocument?.id
      : authoritativePrimaryDocumentId;
  const primaryDocument = React.useMemo(
    () =>
      primaryDocumentId
        ? (documents.find((doc) => doc.id === primaryDocumentId) ?? {
            id: primaryDocumentId,
            uri: `document://${primaryDocumentId}`,
            name: "",
          })
        : undefined,
    [documents, primaryDocumentId],
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
  const { openDocument, t } = useChatHost();
  // A card that mounted already complete belongs to history: never let N old
  // runs fight over the panel. A card mounted for a live call may present every
  // NEW primary id once; the host owns dismissal/manual-selection policy.
  const [autoPresentationEligible] = React.useState(() =>
    isPrimaryAutoPresentationEligible(phase, initialStatus),
  );
  const presentedPrimaryId = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (
      !autoPresentationEligible ||
      !openDocument ||
      !runId ||
      !primaryDocument ||
      presentedPrimaryId.current === primaryDocument.id
    ) {
      return;
    }
    presentedPrimaryId.current = primaryDocument.id;
    openDocument({ id: primaryDocument.id, name: primaryDocument.name }, { trigger: "primary" });
  }, [autoPresentationEligible, openDocument, primaryDocument, runId]);
  // Before any log line: "starting" while the run is still coming up (no status
  // yet, or pending), then "running" once it is — up until the first log
  // replaces it.
  const placeholder = t(effectiveStatus === "running" ? "run.running" : "run.starting");

  // Once the run is terminal, the live log line is replaced by a fixed status
  // label so the card settles on the actual outcome instead of freezing on
  // whatever the last log happened to be. A stable key (-1) lets it animate in.
  // A launch failure (tool errored, no run ever existed) settles on the error
  // message instead — same slot, same height.
  const terminal = isTerminalStatus(effectiveStatus);
  const launchFailed = !runId && phase === "error";
  const line = terminal
    ? { id: -1, text: t(runStatusLineKey(effectiveStatus)) }
    : launchFailed
      ? { id: -1, text: errorText ?? t("run.launchFailed") }
      : current;
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
        aria-label={t("run.details")}
        className="hover:bg-muted/40 absolute inset-0 z-0 rounded-lg"
        onClick={() => setOpen(true)}
      />
      <div className="pointer-events-none relative z-10 flex items-center gap-2 px-3 py-2">
        {/* Leading status glyph — vertically centered across the two lines. */}
        <StatusIcon status={effectiveStatus} phase={phase} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {/* Line 1: package name + live execution time + run-page link */}
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">
              {agentLabel ?? t("run.fallbackLabel")}
            </span>
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
                  title={t("run.openPage")}
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
                className={`${launchFailed ? "text-destructive" : "text-muted-foreground"} animate-in fade-in slide-in-from-bottom-1 col-start-1 row-start-1 truncate duration-300`}
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

      {/* Downloadable document chips (z-10 so they sit above the full-card click
          target and stay individually clickable). */}
      <div className="relative z-10">
        <DocumentChips documents={documents} primaryDocumentId={primaryDocumentId} />
      </div>

      {open ? (
        <Modal title={modalTitle} onClose={() => setOpen(false)}>
          {details}
        </Modal>
      ) : null}
    </div>
  );
}
