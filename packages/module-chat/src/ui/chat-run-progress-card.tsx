// SPDX-License-Identifier: Apache-2.0

/**
 * In-chat run progress component. Rendered for every run-launch tool-call (`runAgent` /
 * `runInline` / `run_and_wait`) — from the moment it starts, before the run id
 * is even known — so the card keeps a constant two-line height with no
 * transient placeholder swap.
 *
 * Drawn as a `RunLine`: the agent's tile leads (a neutral bot tile for an inline run or an agent
 * the `/chat/commands` data does not hold), with the run's state on a badge at its corner.
 * Line 1: the package name, then the agent's integration logos. Line 2: the run's own log-tool output (the
 * `event='log'` rows the platform writes for the agent's explicit `log` tool
 * of `@appstrate/platform` — NOT runtime lifecycle or tool-call breadcrumbs),
 * streamed live over the run's SSE channel (`useRunLogStream`) and paced one
 * at a time (`useLogTicker`, ≥500ms each) with a fade/slide animation so a
 * burst reads as a sequence rather than a flash.
 * Before the first log the line reads `run.starting` (still starting), then
 * `run.running` once running; once terminal it settles on the final outcome (a failed
 * or timed-out run's own error message when it carries one). The live execution time and a
 * link to the run's page sit on the right. Clicking
 * the card opens the run in the host's context panel (`openThreadItem`), where its result, files and log
 * follow it; the launch call's raw input and output stay in the panel's Tools tab.
 *
 * Before the tool returns a `run_…` id there is no SSE yet: the badge falls back to the tool-call phase.
 *
 * A launch failure (tool errored before a run id exists) renders INSIDE this
 * card — error glyph + `errorText` on line 2 — never as a swap to another
 * component, so the block's height stays constant for the call's whole life. No run, nothing to
 * open: the card is then no button.
 */

import * as React from "react";
import { AlertTriangleIcon, ExternalLinkIcon, LockIcon } from "lucide-react";
import { RunStatusIcon } from "@appstrate/ui/components/run-status";
import { Spinner } from "@appstrate/ui/components/spinner";
import { useLiveElapsedMs } from "@appstrate/ui/use-live-elapsed-ms";
import { runReadAccess, useRunLogStream } from "./use-run-log-stream.ts";
import { useLogTicker } from "./use-log-ticker.ts";
import { formatDuration } from "@appstrate/core/format";
import { useCanIn, useChatHost, type ChatHost } from "./runtime-context.ts";
import { CallSpace } from "./call-space.tsx";
import { REVEAL_RING_CLASS, useRevealAnchor } from "./reveal-tool-call.ts";
import {
  autoPresentFile,
  buildRunPageHref,
  isRunAutoPresentEligible,
  isTerminalStatus,
  mergeRunFiles,
  publishedFilesFromLogs,
  runFailureMessage,
  runStatusLineKey,
  visibleLogEntries,
  type ChatRunFile,
} from "./run-events.ts";
import type { RunStatus } from "@appstrate/core/run-status";
import { FileAttachment } from "./file-attachment.tsx";
import type { ToolPhase } from "./tool-result.ts";
import { AgentTile } from "./agent-glyph.tsx";
import { useKnownAgent } from "./use-chat-commands.ts";
import { RunLine } from "./run-line.tsx";
import { SubjectStack } from "./subject-glyph.tsx";
import type { ChatAgentCommand } from "../commands.ts";

/**
 * Row of file attachments surfaced under a run card — the same unified
 * renderer the thread uses for sent attachments: the attachment chip, an image's
 * thumbnail or the file type's icon leading. Clicking a file opens the host's viewer.
 */
function FileChips({ files, spaceId }: { files: ChatRunFile[]; spaceId?: string }) {
  if (files.length === 0) return null;
  return (
    <div className="pointer-events-auto flex flex-wrap gap-1.5 px-3 pb-2">
      {files.map((file) => (
        <FileAttachment
          key={file.id}
          file={{ id: file.id, name: file.name, mime: file.mime, spaceId }}
        />
      ))}
    </div>
  );
}

/** The agent's integrations as stacked logos, named for assistive technology. */
function IntegrationLogos({
  integrations,
  label,
}: {
  integrations: ChatAgentCommand["integrations"];
  label: (names: string) => string;
}) {
  const subjects = React.useMemo(
    () =>
      integrations.map((integration) => ({
        kind: "integration" as const,
        id: integration.id,
        ...(integration.icon && { icon: integration.icon }),
      })),
    [integrations],
  );
  if (subjects.length === 0) return null;
  return (
    <span role="img" aria-label={label(integrations.map((i) => i.name).join(", "))}>
      <SubjectStack subjects={subjects} />
    </span>
  );
}

/**
 * The badge's status icon, sized by the badge (no label — the icon IS the status). Prefers the run's
 * real status (SSE / launch result); until that exists it falls back to the
 * tool-call phase so a just-started run still shows a spinner (or an error
 * state) rather than nothing. A non-terminal run spins; each way of ending has its
 * own icon.
 */
function StatusIcon({
  status,
  phase,
  denied,
}: {
  status: RunStatus | undefined;
  phase: ToolPhase;
  denied: boolean;
}) {
  if (denied) return <LockIcon className="text-muted-foreground" />;
  if (status) {
    return <RunStatusIcon status={status} />;
  }
  if (phase === "error") {
    return <AlertTriangleIcon className="text-destructive" />;
  }
  return <Spinner className="text-muted-foreground" />;
}

export function ChatRunProgressCard({
  toolCallId,
  runId,
  initialStatus,
  agentLabel,
  initialPackageId,
  spaceId,
  initialFiles,
  phase,
  errorText,
}: {
  /** The call the card stands for, when the context panel reveals it by this card. */
  toolCallId?: string | undefined;
  runId: string | undefined;
  initialStatus?: string;
  agentLabel?: string;
  initialPackageId?: string;
  /** The space the call acted in (stamped on every call that acts in a space): the run is read and opened there. */
  spaceId?: string;
  /**
   * Files from the persisted tool result — survive reload; merged with the live
   * and authoritative lists. MUST be referentially stable across renders: a
   * fresh array here defeats the `files` memo, makes `autoPresented` a new
   * object, and re-fires the auto-present effect. The caller
   * (`RunLaunchCard` in `tool-uis.tsx`) memoizes it for that reason — its own
   * renders are driven by assistant-ui, once per stream chunk. The card's
   * internal 500 ms `useLogTicker` is not involved: that state lives here, and
   * it never re-invokes the parent's extraction.
   */
  initialFiles?: ChatRunFile[];
  phase: ToolPhase;
  /** Launch-failure message shown on line 2 when the tool errored without a run id. */
  errorText?: string;
}) {
  const anchor = useRevealAnchor(toolCallId, runId);
  const canIn = useCanIn();
  const {
    logs,
    status,
    packageId,
    startedAt,
    completedAt,
    duration,
    producedFiles,
    producedFilesTruncated,
    sweepDone,
    runDenied,
    error,
  } = useRunLogStream(
    runId,
    initialStatus,
    initialPackageId,
    spaceId,
    runReadAccess((permission) => canIn(spaceId, permission)),
  );

  // Files: the persisted tool-result list (reload-safe), the frames that arrive
  // live over the log stream (`file.published` — chips appear the moment an
  // agent publishes), and the authoritative `/api/files` read the hook performs
  // once the run is terminal. All three hold only files the run PRODUCED — the
  // population the rule counts — and they are UNIONED: the authoritative read
  // comes last so its full metadata wins, but it can never remove a chip the
  // log frames already showed.
  const files = React.useMemo(
    () =>
      mergeRunFiles(mergeRunFiles(initialFiles ?? [], publishedFilesFromLogs(logs)), producedFiles),
    [initialFiles, logs, producedFiles],
  );
  const effectiveStatus =
    status ?? (isTerminalStatus(initialStatus) ? (initialStatus as RunStatus) : undefined);

  // Live execution time — ticks while running, then settles on the
  // server-authoritative `runs.duration` (same value the run page shows).
  // The local `completedAt - startedAt` fallback covers frames that predate
  // the duration column being populated.
  const liveElapsedMs = useLiveElapsedMs(startedAt, completedAt);
  const elapsedMs = duration ?? liveElapsedMs;

  // Pace the log line: a burst of lines plays back one at a time (≥500ms each)
  // rather than flashing straight to the last one. `current` carries a stable
  // `id` so the line element remounts on change and re-runs its enter animation.
  // Memoized: this card lives inside the streaming thread, so it re-renders on
  // every chunk, and the filter walked the whole log array each time.
  const visible = React.useMemo(() => visibleLogEntries(logs), [logs]);
  const current = useLogTicker(visible);
  const { lang, openFile, openThreadItem, t, linkInSpace } = useChatHost();
  // A card that mounted already complete belongs to history: never let N old
  // runs fight over the panel. A card mounted for a live call presents through
  // the exact same host opener as a direct file click.
  const [autoPresentEligible] = React.useState(() =>
    isRunAutoPresentEligible(phase, initialStatus),
  );
  // The whole rule, derived from what the run produced (see `autoPresentFile`).
  const autoPresented = React.useMemo(
    () => autoPresentFile({ files, status: effectiveStatus, sweepDone }),
    [files, effectiveStatus, sweepDone],
  );
  // Fires AT MOST ONCE per card. A file published after the panel already
  // opened does not close it, swap it, or re-open anything: the user is reading
  // what they were handed, and the newcomer is one click away in the chips row.
  const hasAutoPresented = React.useRef(false);
  React.useEffect(() => {
    if (!autoPresentEligible || !runId || !autoPresented) return;
    if (hasAutoPresented.current) return;
    hasAutoPresented.current = true;
    openFile({ id: autoPresented.id, name: autoPresented.name, ...(spaceId && { spaceId }) });
  }, [autoPresentEligible, openFile, autoPresented, runId, spaceId]);
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
  // Without a run read nothing will ever report on a live run: say so rather
  // than reading "starting" forever, and offer no link to a page that 403s.
  const denied = !!runId && runDenied && !terminal;
  const line = terminal
    ? {
        id: -1,
        text: runFailureMessage(effectiveStatus, error) ?? t(runStatusLineKey(effectiveStatus)),
      }
    : launchFailed
      ? { id: -1, text: errorText ?? t("run.launchFailed") }
      : denied
        ? { id: -1, text: t("run.noAccess") }
        : current;
  const effectiveRunHref =
    runId && !runDenied ? runPageHref(linkInSpace, packageId, runId, spaceId) : undefined;
  const agent = useKnownAgent(packageId ? { packageId } : undefined);
  const label = agentLabel ?? t("run.fallbackLabel");

  // `isolate` scopes the internal z-0/z-10 layering to this card — without it
  // the z-10 content escapes into the thread's stacking context and paints
  // over the sticky composer when the card scrolls behind it.
  return (
    <div
      {...anchor}
      className={`bg-card text-card-foreground relative isolate my-2 w-full rounded-lg border ${REVEAL_RING_CLASS}`}
    >
      {/* Full-card click target (opens the run in the panel). Behind the content so
          the run-page link can re-enable pointer events for itself — avoids
          nesting interactive elements. A run out of reach has nothing to show there. */}
      {runId && !runDenied ? (
        <button
          type="button"
          aria-label={t("run.details")}
          className="hover:bg-muted/50 absolute inset-0 z-0 rounded-lg"
          onClick={() => openThreadItem({ kind: "run", id: runId })}
        />
      ) : null}
      <RunLine
        className="pointer-events-none relative z-10 px-3 py-2"
        tile={<AgentTile agent={agent} label={label} />}
        badge={<StatusIcon status={effectiveStatus} phase={phase} denied={denied} />}
        name={label}
        trailing={
          <>
            <IntegrationLogos
              integrations={agent?.integrations ?? []}
              label={(names) => t("run.integrations", { names })}
            />
            <CallSpace spaceId={spaceId} />
            {elapsedMs !== undefined ? (
              <span className="text-muted-foreground text-xs tabular-nums">
                {formatDuration(elapsedMs, lang)}
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
          </>
        }
        // The paced log line, keyed by log id so each new one remounts and runs the fade/slide
        // enter animation over the last.
        sub={
          line ? (
            <span
              key={line.id}
              className={`${launchFailed ? "text-destructive" : ""} animate-in fade-in slide-in-from-bottom-1 ease-surface duration-base font-mono`}
            >
              {line.text}
            </span>
          ) : (
            <span className="font-mono">{placeholder}</span>
          )
        }
      />

      {/* Downloadable file chips (z-10 so they sit above the full-card click
          target and stay individually clickable). The authoritative read is one
          page of at most 100 rows and this card does not page; a run that
          produced more says so rather than showing a silently short list. */}
      <div className="relative z-10">
        <FileChips files={files} spaceId={spaceId} />
        {producedFilesTruncated ? (
          <p className="text-muted-foreground px-3 pb-2 text-xs">{t("run.filesTruncated")}</p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The run's page in the space its call named, through the host's `linkInSpace` (which names the
 * space only when it is not the working one); the server-side reconcile names it itself.
 */
function runPageHref(
  linkInSpace: ChatHost["linkInSpace"],
  packageId: string | undefined,
  runId: string,
  spaceId: string | undefined,
): string | undefined {
  const path = buildRunPageHref(packageId, runId);
  return path && linkInSpace(path, spaceId);
}
