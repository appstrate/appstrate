// SPDX-License-Identifier: Apache-2.0

/**
 * The chat agent's MCP tool calls in the thread. A call is a line (`ThreadCallLine`): what it
 * acted on, its name, its target, then its duration and, when it failed, a small red cross. The
 * thread names, the context panel details: clicking the line opens the call there, its input and
 * output with it. The line is a step under its group's rail (`ToolStep`), or the group's own line
 * when the call is its one step. Its label shimmers while the call is in progress
 * (`isCallInProgress`), as the group's header does.
 *
 * A failure is softened, never hidden: its message stays under the line, muted, and the cross
 * ends the line, named with the HTTP status. Tone is driven by the actual result
 * (`deriveToolPhase`), not the verb.
 *
 * What a call must keep in view whatever its group's fold is drawn under the group's line
 * (the `…Breakout` components): the interactive `OAuthConnectCard` of a connect kickoff, a
 * launched run's line (`ThreadRunLine`), the link to a created package. `run_and_wait` is a run's
 * line of its own, outside any group.
 */

import * as React from "react";
import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { ArrowUpRightIcon } from "lucide-react";
import { formatDuration } from "@appstrate/core/format";
import { useChatHost } from "./runtime-context.ts";
import { REVEAL_RING_CLASS, useRevealAnchor } from "./reveal-tool-call.ts";
import { OAuthConnectCard } from "./oauth-connect-card.tsx";
import { ThreadRunLine } from "./thread-run-line.tsx";
import { CallSpace } from "./call-space.tsx";
import {
  ACTIVITY_BLOCK_CLASS,
  ActivityId,
  ActivityLine,
  ActivityTrigger,
} from "./activity-line.tsx";
import { CallLine, CallName } from "./call-step.tsx";
import {
  extractAgentLabel,
  extractRunFiles,
  extractRunId,
  extractRunPackageId,
  extractRunStatus,
  isRunLaunchOp,
} from "./run-events.ts";
import {
  extractAuthOffers,
  extractRunAndWaitAuthOffers,
  isStartedRunResult,
} from "./auth-offer.ts";
import {
  packageCreatedByImport,
  packageCreatedByOperation,
  packagePageHref,
  type CreatedPackage,
} from "./package-created.ts";
import { showCall } from "./tool-presentation.ts";
import { isCallInProgress } from "./turn-status.ts";
import { callPartSpaceOf, type StoredResult } from "./use-call-presentation.ts";
import { SubjectGlyph, SubjectStack } from "./subject-glyph.tsx";
import {
  deriveToolPhase,
  extractErrorMessage,
  httpStatusOf,
  unwrapToolResult,
} from "./tool-result.ts";

/**
 * `invoke_operation` operationId that kicks off an integration connect flow.
 * `initiateIntegrationConnect` is the unified, auth-type-agnostic op
 * whose result carries a `connect_url`; its result renders the connect
 * card (button + auto-resume on completion — see oauth-connect-card).
 */
const INITIATE_CONNECT_OP = "initiateIntegrationConnect";

/** A tool part's props: the part, and what its stored part says (`useStoredResults`). */
export type ToolPartProps = ToolCallMessagePartProps<Record<string, unknown>, unknown> & {
  stored?: StoredResult | undefined;
};

/**
 * Render run-launch tool calls as the run's line in the thread, from the launch to its terminal
 * status.
 *
 * A component because it holds a hook: `InvokeOperationTool` reaches this branch conditionally.
 * The memo keeps `initialFiles` referentially stable per result, which `ThreadRunLine` memoizes on.
 */
function RunLaunchLine({
  anchorsCall,
  ...props
}: ToolPartProps & {
  /** The line is the call's whole display, so the context panel reveals the call by it. */
  anchorsCall: boolean;
}): React.ReactNode {
  const runId = extractRunId(props.result);
  const initialFiles = React.useMemo(() => extractRunFiles(props.result), [props.result]);
  const agentLabel = extractAgentLabel(props.args);
  const phase = deriveToolPhase(props);
  // Run-page link needs package id. The result normally carries it; for agent
  // runs the label is also the package id (`@scope/name`), so it is a safe fallback.
  // Inline labels are manifest names, not package ids, so they wait for result/fetch.
  const packageId =
    extractRunPackageId(props.result) ?? (agentLabel?.startsWith("@") ? agentLabel : undefined);
  // The call names the space the run ran in: the line reads and links there.
  const spaceId = callPartSpaceOf(props);
  return (
    <ThreadRunLine
      toolCallId={anchorsCall ? props.toolCallId : undefined}
      runId={runId}
      initialStatus={extractRunStatus(props.result)}
      agentLabel={agentLabel}
      initialPackageId={packageId}
      spaceId={spaceId}
      initialFiles={initialFiles}
      phase={phase}
      errorText={
        phase === "error" ? extractErrorMessage(unwrapToolResult(props.result)) : undefined
      }
    />
  );
}

/** `invoke_operation`'s arguments, as its lines read them. */
type InvokeOperationArgs = { operation_id?: string; path_params?: { packageId?: string } };

/** A call as its thread line reads it: the assistant-ui part, and what its stored part says. */
type LineCall = Parameters<typeof deriveToolPhase>[0] & {
  readonly toolCallId: string;
  readonly providerMetadata?: unknown;
  readonly stored?: StoredResult | undefined;
};

/**
 * A call's line in the thread: its name is a button opening the call in the context panel, which
 * holds its input and output (the thread names, the panel details). What a search found, the space
 * and the duration follow it; a failure ends it with its cross, its message under it.
 */
export function ThreadCallLine({
  call,
  lead,
  label,
  idText,
  running,
  trailing,
}: {
  call: LineCall;
  lead: React.ReactNode;
  label: string;
  idText?: string | undefined;
  running: boolean;
  /** What ends the line's trailing content (the running turn's clock, for a group's lone call). */
  trailing?: React.ReactNode;
}) {
  const { t, lang, openThreadItem } = useChatHost();
  const anchor = useRevealAnchor(call.toolCallId);
  const presentation = call.stored?.presentation;
  // `unwrapToolResult` JSON-parses the tool payload. Unmemoized it re-parsed on every render of
  // this line, and during a stream the thread re-renders per chunk.
  const unwrapped = React.useMemo(() => unwrapToolResult(call.result), [call.result]);
  const failed = deriveToolPhase(call) === "error";
  const status = httpStatusOf(unwrapped);
  const durationMs = call.stored?.durationMs;
  const spaceId = callPartSpaceOf(call);

  return (
    <div {...anchor} className={`rounded-sm ${REVEAL_RING_CLASS}`}>
      <CallLine
        lead={lead}
        control={
          <ActivityTrigger onClick={() => openThreadItem({ kind: "call", id: call.toolCallId })}>
            <CallName label={label} idText={idText} running={running} />
          </ActivityTrigger>
        }
        trailing={
          <>
            {presentation?.call === "search" ? (
              <span className="flex shrink-0 items-center gap-1.5 text-xs">
                <SubjectStack subjects={presentation.items} />
                {t("tool.search.count", { count: presentation.count })}
              </span>
            ) : null}
            <CallSpace spaceId={spaceId} />
            {durationMs !== undefined ? (
              <span className="shrink-0 text-xs tabular-nums">
                {formatDuration(durationMs, lang)}
              </span>
            ) : null}
            {trailing}
          </>
        }
        failure={
          failed
            ? { label: status === undefined ? t("tool.failed") : t("tool.failedHttp", { status }) }
            : undefined
        }
        errorText={failed ? extractErrorMessage(unwrapped) : undefined}
      />
    </div>
  );
}

/** A tool call as a step under its activity group's rail, named as the context panel names it. */
export function ToolStep(props: ToolPartProps) {
  const { t } = useChatHost();
  const { Icon, subject, label, idText } = showCall(
    { ...props, presentation: props.stored?.presentation },
    t,
  );
  return (
    <ThreadCallLine
      call={props}
      lead={subject ? <SubjectGlyph subject={subject} /> : <Icon aria-hidden />}
      label={label}
      idText={idText}
      running={isCallInProgress(props)}
    />
  );
}

/**
 * What an `invoke_operation` keeps in view under its group's line, whatever the fold: the connect
 * card of a connect kickoff, a launched run's line, the link to a package it created. Nothing
 * for any other operation: its step says it all.
 */
export function InvokeOperationBreakout(props: ToolPartProps) {
  const { result } = props;
  const args = props.args as InvokeOperationArgs | undefined;
  const opId = args?.operation_id ?? "";
  const phase = deriveToolPhase(props);

  // Mounted from the kickoff's first frame (before the result carries the connect url), so the
  // connect card does not appear mid-stream; a failure shows in place. A success without an offer draws
  // none.
  if (opId === INITIATE_CONNECT_OP) {
    // One connect card: the route behind this operation mints a single `connect_url`.
    const offer = extractAuthOffers(result)[0];
    if (!offer && phase === "success") return null;
    return (
      <OAuthConnectCard
        // It reads the integration where the call acted.
        spaceId={callPartSpaceOf(props)}
        authUrl={offer?.authUrl}
        state={offer?.state}
        // The session route returns no `packageId`; the call's own path
        // param is the integration this connect card connects.
        packageId={args?.path_params?.packageId}
        toolCallId={props.toolCallId}
        errorText={
          phase === "error" && !offer ? extractErrorMessage(unwrapToolResult(result)) : undefined
        }
      />
    );
  }

  // Run launch (runAgent / runInline): the run's progress, from the launch to its terminal
  // status. A launch refused started no run: its step says so, and no run's line stands for it.
  if (isRunLaunchOp(opId)) {
    if (phase === "error" && !extractRunId(result)) return null;
    return <RunLaunchLine {...props} anchorsCall={false} />;
  }

  const created =
    phase === "success" ? packageCreatedByOperation(opId, unwrapToolResult(result)) : null;
  return created ? (
    <CreatedPackageLink
      created={created}
      toolCallId={props.toolCallId}
      spaceId={callPartSpaceOf(props)}
    />
  ) : null;
}

/** Tool calls whose package write the host was already told about, this page life. */
const announcedPackageWrites = new Set<string>();

/**
 * The package a tool call created, one click away. Mounting it tells the host
 * once per call, so its package lists show what the assistant just made.
 */
function CreatedPackageLink({
  created,
  toolCallId,
  spaceId,
}: {
  created: CreatedPackage;
  toolCallId: string;
  spaceId: string | undefined;
}) {
  const { t, onPackagesChanged, linkInSpace } = useChatHost();
  React.useEffect(() => {
    if (announcedPackageWrites.has(toolCallId)) return;
    announcedPackageWrites.add(toolCallId);
    onPackagesChanged();
  }, [toolCallId, onPackagesChanged]);
  const href = linkInSpace(packagePageHref(created), spaceId);
  if (!href) return null;
  return (
    <ActivityLine lead={<ArrowUpRightIcon aria-hidden className="text-primary" />}>
      <a
        href={href}
        className="text-primary flex min-w-0 items-center gap-1.5 font-medium hover:underline"
      >
        {t("tool.packageCreated.open")}
        <ActivityId>{created.packageId}</ActivityId>
      </a>
    </ActivityLine>
  );
}

/** The link to the package an import created, in view under its group's line. */
export function ImportPackageBreakout(props: ToolPartProps) {
  const created =
    deriveToolPhase(props) === "success"
      ? packageCreatedByImport(unwrapToolResult(props.result))
      : null;
  return created ? (
    <CreatedPackageLink
      created={created}
      toolCallId={props.toolCallId}
      spaceId={callPartSpaceOf(props)}
    />
  ) : null;
}

// `run_and_wait` is its own MCP tool (not invoke_operation), outside any activity group, so it
// draws its own block — the run's line the invoke-operation run-launch branch renders, in the room
// a group takes (`ACTIVITY_BLOCK_CLASS`). Chat emits the run id as a preliminary result; the line is
// mounted for the call's whole life (a launch failure's message goes under it).
//
// A launch refused for a missing connection (409) carries a ready-to-open
// `connect_url` per actionable integration, so the connect cards render
// UNDER the run's line and the user clicks straight through — the model is never
// asked to kick a connect flow off, and never sees the link. A run that started
// without an optional integration carries the same link on its warning, shown
// once the call settles — by then it may have lapsed, so the connect card gets its expiry.
// Zero offers adds nothing: unlike the invoke_operation connect branch there is
// no placeholder here, because the run's line already holds its geometry.
export function RunAndWaitTool(props: ToolPartProps) {
  return (
    <>
      <div className={ACTIVITY_BLOCK_CLASS}>
        <RunLaunchLine {...props} anchorsCall />
      </div>
      {extractRunAndWaitAuthOffers(props).map((offer) => (
        <OAuthConnectCard
          key={offer.authUrl}
          spaceId={callPartSpaceOf(props)}
          authUrl={offer.authUrl}
          state={offer.state}
          packageId={offer.packageId}
          toolCallId={props.toolCallId}
          runStarted={isStartedRunResult(props.result)}
          expiresAt={offer.expiresAt}
        />
      ))}
    </>
  );
}
