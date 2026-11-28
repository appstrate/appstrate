// SPDX-License-Identifier: Apache-2.0

/**
 * A run in the thread, on one line: the line every activity of the thread is drawn with (`CallLine`,
 * `call-step.tsx`, the one `ThreadCallLine` draws a tool call with), so a run reads in the thread's
 * rhythm. No box: the thread names, the context panel details. Rendered for every run-launch
 * tool-call (`runAgent` / `runInline` / `run_and_wait`) from the moment it starts, before the run id
 * is even known, on a line of fixed height: nothing that arrives later moves the block.
 *
 * The lead is the agent's 16px identity tile (`AgentTile`; a neutral bot tile for an inline run or
 * an agent the `/chat/commands` data does not hold). The control is the agent's name (its title in
 * that data, else the launch's label), shimmering while the run is in flight: a button opening the
 * run in the host's context panel (`openThreadItem`), where its result, files and log follow it;
 * plain text when there is no run to open (a launch that failed, a run the reader cannot read).
 * After it, muted: the run's state, a status icon and its text, which is the run's own log-tool
 * output while it goes (the `event='log'` rows the platform writes for the agent's explicit `log`
 * tool of `@appstrate/platform`, NOT runtime lifecycle or tool-call breadcrumbs), streamed over the
 * run's SSE channel (`useRunLogStream`) and paced one at a time (`useLogTicker`, ≥500ms each) with
 * a fade/slide animation, truncated in the room left; `run.starting` before the first log, then
 * `run.running`, and the outcome's short label once terminal. Then the duration, the agent's
 * integration logos, the run's space and the run page's link.
 *
 * What a short state cannot say goes under the line, in full and muted, aligned on the name, as a
 * failed call's message does: a failed or timed-out run's own error, a launch failure's message
 * (the tool errored before a run id existed), the notice that the reader's role cannot read the
 * run. The run's file chips and the notice of a truncated file list follow it, on the same indent.
 * The launch call's raw input and output stay in the panel's Tools tab.
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
  runOutcomeText,
  runStatusLineKey,
  visibleLogEntries,
  type ChatRunFile,
} from "./run-events.ts";
import type { RunStatus } from "@appstrate/core/run-status";
import { FileAttachment } from "./file-attachment.tsx";
import type { ToolPhase } from "./tool-result.ts";
import { AgentTile } from "./agent-glyph.tsx";
import { useKnownAgent } from "./use-chat-commands.ts";
import { ActivityTrigger } from "./activity-line.tsx";
import { CallLine, CallName } from "./call-step.tsx";
import { SubjectStack } from "./subject-glyph.tsx";
import type { ChatAgentCommand } from "../commands.ts";

/** What sits under the line, aligned on the name (the indent of `CallLine`'s `errorText`). */
const UNDER_LINE_CLASS = "pb-1.5 pl-6";

/**
 * Row of file attachments surfaced under a run's line — the same unified renderer the thread uses
 * for sent attachments: the attachment chip, an image's thumbnail or the file type's icon leading.
 * Clicking a file opens the host's viewer.
 */
function FileChips({ files, spaceId }: { files: ChatRunFile[]; spaceId?: string }) {
  if (files.length === 0) return null;
  return (
    <div className={`flex flex-wrap gap-1.5 ${UNDER_LINE_CLASS}`}>
      {files.map((file) => (
        <FileAttachment
          key={file.id}
          file={{ id: file.id, name: file.name, mime: file.mime, spaceId }}
        />
      ))}
    </div>
  );
}

/**
 * The agent's integrations as stacked logos (each its manifest `icon`, drawn by the
 * `IntegrationIcon` the panel's Runs tab draws too), named for assistive technology.
 */
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
        ...(integration.icon && { icons: [{ src: integration.icon }] }),
      })),
    [integrations],
  );
  if (subjects.length === 0) return null;
  return (
    <span
      className="flex shrink-0"
      role="img"
      aria-label={label(integrations.map((i) => i.name).join(", "))}
    >
      <SubjectStack subjects={subjects} />
    </span>
  );
}

/**
 * The run's status icon, beside the state's text (no label — the text says it). Prefers the run's
 * real status (SSE / launch result); until that exists it falls back to the tool-call phase so a
 * just-started run still shows a spinner (or an error state) rather than nothing. A non-terminal
 * run spins; each way of ending has its own icon, a failure its one cross.
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

export function ThreadRunLine({
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
  /** The call the line stands for, when the context panel reveals it by this line. */
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
   * (`RunLaunchLine` in `tool-uis.tsx`) memoizes it for that reason — its own
   * renders are driven by assistant-ui, once per stream chunk. The line's
   * internal 500 ms `useLogTicker` is not involved: that state lives here, and
   * it never re-invokes the parent's extraction.
   */
  initialFiles?: ChatRunFile[];
  phase: ToolPhase;
  /** Launch-failure message shown under the line when the tool errored without a run id. */
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
  // Memoized: this line lives inside the streaming thread, so it re-renders on
  // every chunk, and the filter walked the whole log array each time.
  const visible = React.useMemo(() => visibleLogEntries(logs), [logs]);
  const current = useLogTicker(visible);
  const { lang, openFile, openThreadItem, t, linkInSpace } = useChatHost();
  // A line that mounted already complete belongs to history: never let N old
  // runs fight over the panel. A line mounted for a live call presents through
  // the exact same host opener as a direct file click.
  const [autoPresentEligible] = React.useState(() =>
    isRunAutoPresentEligible(phase, initialStatus),
  );
  // The whole rule, derived from what the run produced (see `autoPresentFile`).
  const autoPresented = React.useMemo(
    () => autoPresentFile({ files, status: effectiveStatus, sweepDone }),
    [files, effectiveStatus, sweepDone],
  );
  // Fires AT MOST ONCE per line. A file published after the panel already
  // opened does not close it, swap it, or re-open anything: the user is reading
  // what they were handed, and the newcomer is one click away in the chips row.
  const hasAutoPresented = React.useRef(false);
  React.useEffect(() => {
    if (!autoPresentEligible || !runId || !autoPresented) return;
    if (hasAutoPresented.current) return;
    hasAutoPresented.current = true;
    openFile({ id: autoPresented.id, name: autoPresented.name, ...(spaceId && { spaceId }) });
  }, [autoPresentEligible, openFile, autoPresented, runId, spaceId]);

  const terminal = isTerminalStatus(effectiveStatus);
  const launchFailed = !runId && phase === "error";
  // Without a run read nothing will ever report on a live run: say so rather
  // than reading "starting" forever, and offer no link to a page that 403s.
  const denied = !!runId && runDenied && !terminal;
  const inFlight = !terminal && !launchFailed && !denied;
  // The state's short text, keyed so each new one remounts and runs the enter animation over the
  // last: once terminal the outcome's label, a launch failure its own, a live run its paced log
  // line (`run.starting` / `run.running` before the first). A denied run's line holds its lock
  // alone; its notice is under the line.
  const state = terminal
    ? { id: -1, text: t(runStatusLineKey(effectiveStatus)), log: false }
    : launchFailed
      ? { id: -1, text: t("run.launchFailed"), log: false }
      : denied
        ? undefined
        : current
          ? { id: current.id, text: current.text, log: true }
          : { id: -1, text: runOutcomeText(effectiveStatus, error, t), log: false };
  // What the short state cannot say, under the line, in full.
  const underText = launchFailed
    ? errorText
    : denied
      ? t("run.noAccess")
      : runFailureMessage(effectiveStatus, error);
  const effectiveRunHref =
    runId && !runDenied ? runPageHref(linkInSpace, packageId, runId, spaceId) : undefined;
  const agent = useKnownAgent(packageId ? { packageId } : undefined);
  const label = agent?.title ?? agentLabel ?? t("run.fallbackLabel");
  const name = <CallName label={label} running={inFlight} />;

  return (
    <div {...anchor} className={`rounded-sm ${REVEAL_RING_CLASS}`}>
      <CallLine
        lead={<AgentTile agent={agent} label={label} />}
        control={
          runId && !runDenied ? (
            <ActivityTrigger onClick={() => openThreadItem({ kind: "run", id: runId })}>
              {name}
            </ActivityTrigger>
          ) : (
            name
          )
        }
        trailing={
          <>
            {/* The state shrinks before anything else and truncates: a long log line never wraps,
                and never pushes what follows out of the line. */}
            <span className="flex min-w-0 items-center gap-1.5 overflow-hidden text-xs">
              <span aria-hidden className="flex shrink-0 [&_svg]:size-3.5">
                <StatusIcon status={effectiveStatus} phase={phase} denied={denied} />
              </span>
              {state ? (
                <span className="grid min-w-0 *:col-start-1 *:row-start-1 *:truncate">
                  <span
                    key={state.id}
                    className={`${state.log ? "font-mono" : ""}animate-in fade-in slide-in-from-bottom-1 ease-surface duration-base`}
                  >
                    {state.text}
                  </span>
                </span>
              ) : null}
            </span>
            {elapsedMs !== undefined ? (
              <span className="shrink-0 text-xs tabular-nums">
                {formatDuration(elapsedMs, lang)}
              </span>
            ) : null}
            <IntegrationLogos
              integrations={agent?.integrations ?? []}
              label={(names) => t("run.integrations", { names })}
            />
            <CallSpace spaceId={spaceId} />
            {effectiveRunHref ? (
              <a
                href={effectiveRunHref}
                className="hover:text-foreground flex h-full shrink-0 items-center"
                title={t("run.openPage")}
              >
                <ExternalLinkIcon className="size-3.5" />
              </a>
            ) : null}
          </>
        }
        errorText={underText}
      />
      {/* The authoritative read is one page of at most 100 rows and this line does not page; a
          run that produced more says so rather than showing a silently short list. */}
      <FileChips files={files} spaceId={spaceId} />
      {producedFilesTruncated ? (
        <p className={`text-muted-foreground text-xs ${UNDER_LINE_CLASS}`}>
          {t("run.filesTruncated")}
        </p>
      ) : null}
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
