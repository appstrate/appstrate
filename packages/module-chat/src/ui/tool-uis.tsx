// SPDX-License-Identifier: Apache-2.0

/**
 * The chat agent's MCP tool calls in the thread. A call is a line (`ThreadCallLine`): what it
 * acted on, its name, its target, then its duration and, when it failed, a small red cross. The
 * thread names, the context panel details: clicking the line opens the call there, its input and
 * output with it. The line is a step under its group's rail (`ToolStep`), or the group's own line
 * when the call is its one step.
 *
 * A failure is softened, never hidden: its message stays under the line, muted, and the cross
 * ends the line, named with the HTTP status. Tone is driven by the actual result
 * (`deriveToolPhase`), not the verb.
 *
 * What a call must keep in view whatever its group's fold is drawn under the group's line
 * (the `…Breakout` components): the interactive `OAuthConnectCard` of a connect kickoff, a
 * launched run's `ChatRunProgressCard`, the link to a created package. `run_and_wait` is a card
 * of its own, outside any group.
 */

import * as React from "react";
import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { ArrowUpRightIcon } from "lucide-react";
import { formatDuration } from "@appstrate/core/format";
import { useChatHost } from "./runtime-context.ts";
import { REVEAL_RING_CLASS, useRevealAnchor } from "./reveal-tool-call.ts";
import { OAuthConnectCard } from "./oauth-connect-card.tsx";
import { ChatRunProgressCard } from "./chat-run-progress-card.tsx";
import { CallSpace } from "./call-space.tsx";
import { ActivityId, ActivityLine, ActivityTrigger } from "./activity-line.tsx";
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
import { cardSpaceOf, type StoredResult } from "./use-call-presentation.ts";
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

/** A card's props: its part, and what its stored part says (`useStoredResults`). */
export type ToolCardProps = ToolCallMessagePartProps<Record<string, unknown>, unknown> & {
  stored?: StoredResult | undefined;
};

/**
 * Render run-launch tool calls as in-chat run progress while launch/run state is
 * available.
 *
 * A real component, not a `build…()` helper called inline: `ChatRunProgressCard`
 * memoizes its file set on the `initialFiles` prop, and this is where that array
 * is derived. Computed inline it was a fresh array every time THIS component
 * rendered — which assistant-ui does once per stream chunk while the tool part
 * is live — so the memo missed on each of those, the auto-present candidate was
 * a new object, and the effect that opens it re-ran (only a ref kept the result
 * correct). Note the card's own 500 ms log ticker is NOT the trigger: it is
 * state inside the child, and a child's re-render never re-invokes this
 * extraction. Hooks need a component, and `InvokeOperationTool` reaches this
 * branch conditionally, so the `useMemo` cannot live in its body.
 */
function RunLaunchCard({
  anchorsCall,
  ...props
}: ToolCardProps & {
  /** The card is the call's whole display, so the context panel reveals the call by it. */
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
  // The call names the space the run ran in: the card reads and links there.
  const spaceId = cardSpaceOf(props);
  return (
    <ChatRunProgressCard
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

/** `invoke_operation`'s arguments, as its cards read them. */
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
 * and the duration follow it; a failure ends it with its cross, its message under it. `clock`: the
 * line is its group's, the turn's status while the turn runs; the turn's clock ("" until its first
 * tick) stands for what the call says after its name.
 */
export function ThreadCallLine({
  call,
  lead,
  label,
  idText,
  running,
  clock,
}: {
  call: LineCall;
  lead: React.ReactNode;
  label: string;
  idText?: string | undefined;
  running: boolean;
  clock?: string | undefined;
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
  const spaceId = cardSpaceOf(call);

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
          clock !== undefined ? (
            clock ? (
              <span className="shrink-0 tabular-nums">{clock}</span>
            ) : null
          ) : (
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
            </>
          )
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
export function ToolStep(props: ToolCardProps) {
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
      running={deriveToolPhase(props) === "running"}
    />
  );
}

/**
 * What an `invoke_operation` keeps in view under its group's line, whatever the fold: the connect
 * card of a connect kickoff, a launched run's progress, the link to a package it created. Nothing
 * for any other operation: its step says it all.
 */
export function InvokeOperationBreakout(props: ToolCardProps) {
  const { result } = props;
  const args = props.args as InvokeOperationArgs | undefined;
  const opId = args?.operation_id ?? "";
  const phase = deriveToolPhase(props);

  // Mounted from the kickoff's first frame (before the result carries the connect url), so the
  // card does not appear mid-stream; a failure shows in place. A success without an offer draws
  // none.
  if (opId === INITIATE_CONNECT_OP) {
    // One card: the route behind this operation mints a single `connect_url`.
    const offer = extractAuthOffers(result)[0];
    if (!offer && phase === "success") return null;
    return (
      <OAuthConnectCard
        // It reads the integration where the call acted.
        spaceId={cardSpaceOf(props)}
        authUrl={offer?.authUrl}
        state={offer?.state}
        // The session route returns no `packageId`; the call's own path
        // param is the integration this card connects.
        packageId={args?.path_params?.packageId}
        toolCallId={props.toolCallId}
        errorText={
          phase === "error" && !offer ? extractErrorMessage(unwrapToolResult(result)) : undefined
        }
      />
    );
  }

  // Run launch (runAgent / runInline): the run's progress, from the launch to its terminal
  // status. A launch refused started no run: its step says so, and no card stands for it.
  if (isRunLaunchOp(opId)) {
    if (phase === "error" && !extractRunId(result)) return null;
    return <RunLaunchCard {...props} anchorsCall={false} />;
  }

  const created =
    phase === "success" ? packageCreatedByOperation(opId, unwrapToolResult(result)) : null;
  return created ? (
    <CreatedPackageLink
      created={created}
      toolCallId={props.toolCallId}
      spaceId={cardSpaceOf(props)}
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
export function ImportPackageBreakout(props: ToolCardProps) {
  const created =
    deriveToolPhase(props) === "success"
      ? packageCreatedByImport(unwrapToolResult(props.result))
      : null;
  return created ? (
    <CreatedPackageLink
      created={created}
      toolCallId={props.toolCallId}
      spaceId={cardSpaceOf(props)}
    />
  ) : null;
}

// `run_and_wait` is its own MCP tool (not invoke_operation), so it needs its own
// card — the same component the invoke-operation run-launch branch renders. Chat
// emits the run id as a preliminary result; the progress panel is mounted for
// the call's whole life (launch failures render inside it) — no generic-card
// fallback swap.
//
// A launch refused for a missing connection (409) carries a ready-to-open
// `connect_url` per actionable integration, so the connect cards render
// UNDER the run panel and the user clicks straight through — the model is never
// asked to kick a connect flow off, and never sees the link. A run that started
// without an optional integration carries the same link on its warning, shown
// once the call settles — by then it may have lapsed, so the card gets its expiry.
// Zero offers adds nothing: unlike the invoke_operation connect branch there is
// no placeholder card here, because the run panel already holds its geometry.
export function RunAndWaitTool(props: ToolCardProps) {
  return (
    <>
      <RunLaunchCard {...props} anchorsCall />
      {extractRunAndWaitAuthOffers(props).map((offer) => (
        <OAuthConnectCard
          key={offer.authUrl}
          spaceId={cardSpaceOf(props)}
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
