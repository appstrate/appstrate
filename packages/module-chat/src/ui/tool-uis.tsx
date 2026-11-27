// SPDX-License-Identifier: Apache-2.0

/**
 * The chat agent's MCP tool calls in the thread. A call is a step of its activity group
 * (`ToolStep`): a line with what it acted on, its name, its target, then its duration and, when
 * it failed, a small red cross. Its full (technical) input / output opens under the line as raw
 * JSON: parsing arbitrary API payloads into a field table reads worse than monospace JSON, and
 * JSON keeps every field intact.
 *
 * A failure is softened, never hidden: its message stays under the line, muted, and the cross
 * ends the line; the HTTP status is in the call's detail. Tone is driven by the actual result
 * (`deriveToolPhase`), not the verb.
 *
 * What a call must keep in view whatever its group's fold is drawn under the group's line
 * (the `…Breakout` components): the interactive `OAuthConnectCard` of a connect kickoff, a
 * launched run's `ChatRunProgressCard`, the link to a created package. `run_and_wait` is a card
 * of its own, outside any group.
 */

import * as React from "react";
import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { ArrowUpRightIcon, BracesIcon, PlayIcon, XIcon } from "lucide-react";
import { formatDuration } from "@appstrate/core/format";
import { Button } from "@appstrate/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@appstrate/ui/components/collapsible";
import { StructuredOutput } from "@appstrate/ui/components/structured-output";
import { useChatHost } from "./runtime-context.ts";
import { ToolCallDetail } from "./tool-call-detail.tsx";
import { REVEAL_RING_CLASS, useRevealAnchor } from "./reveal-tool-call.ts";
import { OAuthConnectCard } from "./oauth-connect-card.tsx";
import { ChatRunProgressCard } from "./chat-run-progress-card.tsx";
import { CallSpace } from "./call-space.tsx";
import {
  ACTIVITY_CONTENT_CLASS,
  ACTIVITY_DETAIL_CLASS,
  ActivityChevron,
  ActivityId,
  ActivityLabel,
  ActivityLine,
  ActivityTrigger,
} from "./activity-line.tsx";
import { useActivityMode } from "./activity-mode.ts";
import {
  extractAgentLabel,
  extractRunFiles,
  extractRunId,
  extractRunOutput,
  extractRunPackageId,
  extractRunStatus,
  isRunLaunchOp,
} from "./run-events.ts";
import {
  extractAuthOffers,
  extractRunAndWaitAuthOffers,
  isStartedRunResult,
} from "./auth-offer.ts";
import { asRecordOrNull } from "@appstrate/core/safe-json";
import {
  packageCreatedByImport,
  packageCreatedByOperation,
  packagePageHref,
  type CreatedPackage,
} from "./package-created.ts";
import { unwrapMcpResult } from "@appstrate/core/mcp-result";
import { showCall } from "./tool-presentation.ts";
import { cardSpaceOf, type StoredResult } from "./use-call-presentation.ts";
import { SubjectGlyph, SubjectStack } from "./subject-glyph.tsx";
import {
  definedEntries,
  deriveToolPhase,
  extractErrorMessage,
  httpStatusOf,
} from "./tool-result.ts";

/**
 * `invoke_operation` operationId that kicks off an integration connect flow.
 * `initiateIntegrationConnect` is the unified, auth-type-agnostic op
 * whose result carries a `connect_url`; its result renders the connect
 * card (button + auto-resume on completion — see oauth-connect-card).
 */
const INITIATE_CONNECT_OP = "initiateIntegrationConnect";

// assistant-stream ToolCallTiming = { startedAt, completedAt? } (epoch ms;
// completedAt absent while running).
function readDurationMs(timing: unknown): number | undefined {
  const t = asRecordOrNull(timing);
  if (t && typeof t.startedAt === "number" && typeof t.completedAt === "number") {
    return t.completedAt - t.startedAt;
  }
  return undefined;
}

/**
 * The small red cross of a failed call, the only red its row keeps. Given a `label` it is an image
 * named by it; without one it is decorative, beside a text that already says the failure.
 */
export function FailedGlyph({ label }: { label?: string }) {
  return (
    <span
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
      className="text-destructive shrink-0"
    >
      <XIcon className="size-3.5" />
    </span>
  );
}

/** A card's props: its part, and what its stored part says (`useStoredResults`). */
export type ToolCardProps = ToolCallMessagePartProps<Record<string, unknown>, unknown> & {
  stored?: StoredResult | undefined;
};

/**
 * A finished run's detail: its structured output as labelled facts, the raw
 * input/output/metadata JSON one toggle away. The chat has no output schema to
 * hand (inline runs declare an open one), so the labels are the field keys.
 */
function RunOutputDetails({
  output,
  raw,
}: {
  output: Record<string, unknown>;
  raw: React.ReactNode;
}) {
  const { t } = useChatHost();
  const [showJson, setShowJson] = React.useState(false);
  return (
    <div className="space-y-4">
      {showJson ? raw : <StructuredOutput value={output} />}
      <Button variant="outline" size="sm" onClick={() => setShowJson((v) => !v)}>
        <BracesIcon />
        {showJson ? t("run.output.showFields") : t("run.output.showJson")}
      </Button>
    </div>
  );
}

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
  const { t } = useChatHost();
  const runId = extractRunId(props.result);
  const initialFiles = React.useMemo(() => extractRunFiles(props.result), [props.result]);
  // Same reason as `ToolCallCard` — see the note there.
  const unwrapped = React.useMemo(() => unwrapMcpResult(props.result), [props.result]);
  const meta = definedEntries({
    tool_call_id: props.toolCallId,
    is_error: props.isError,
    http_status: httpStatusOf(unwrapped),
    duration_ms: readDurationMs(props.timing),
  });
  const agentLabel = extractAgentLabel(props.args);
  const phase = deriveToolPhase(props);
  const modalTitle = (
    <span className="flex items-center gap-2">
      <PlayIcon className="size-4 shrink-0" />
      {agentLabel ?? "Run"}
    </span>
  );
  const output = React.useMemo(() => extractRunOutput(props.result), [props.result]);
  const rawDetails = <ToolCallDetail t={t} input={props.args} output={unwrapped} metadata={meta} />;
  const details = output ? <RunOutputDetails output={output} raw={rawDetails} /> : rawDetails;
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
      errorText={phase === "error" ? extractErrorMessage(unwrapped) : undefined}
      modalTitle={modalTitle}
      details={details}
    />
  );
}

/** `invoke_operation`'s arguments, as its cards read them. */
type InvokeOperationArgs = { operation_id?: string; path_params?: { packageId?: string } };

/**
 * A tool call as a step of its activity group: named as the context panel names it (`showCall`),
 * with what a search found beside it. Its label shimmers while it runs; its detail opens under
 * it, already open when it is its group's one step.
 */
export function ToolStep(props: ToolCardProps) {
  const { t, lang } = useChatHost();
  const anchor = useRevealAnchor(props.toolCallId);
  const solo = useActivityMode()?.solo ?? false;
  const [readerOpen, setReaderOpen] = React.useState<boolean | null>(null);
  const presentation = props.stored?.presentation;
  const phase = deriveToolPhase(props);
  const { Icon, subject, label, idText } = showCall({ ...props, presentation }, t);
  // `unwrapMcpResult` JSON-parses the tool payload. Unmemoized it re-parsed on every render of
  // this step, and during a stream the thread re-renders per chunk.
  const unwrapped = React.useMemo(() => unwrapMcpResult(props.result), [props.result]);
  const status = httpStatusOf(unwrapped);
  const durationMs = readDurationMs(props.timing);
  const errorMsg = phase === "error" ? extractErrorMessage(unwrapped) : undefined;

  return (
    <Collapsible
      {...anchor}
      open={readerOpen ?? solo}
      onOpenChange={setReaderOpen}
      className={`rounded-sm ${REVEAL_RING_CLASS}`}
    >
      {/* What lands with the result (duration, cross) follows the trigger on a line of fixed
          height: its arrival moves nothing. */}
      <ActivityLine lead={subject ? <SubjectGlyph subject={subject} /> : <Icon aria-hidden />}>
        <CollapsibleTrigger asChild>
          <ActivityTrigger>
            <ActivityLabel active={phase === "running"}>{label}</ActivityLabel>
            {idText ? <ActivityId>{idText}</ActivityId> : null}
            <ActivityChevron />
          </ActivityTrigger>
        </CollapsibleTrigger>
        {presentation?.count !== undefined ? (
          <span className="flex shrink-0 items-center gap-1.5 text-xs">
            <SubjectStack subjects={presentation.items ?? []} />
            {t("tool.search.count", { count: presentation.count })}
          </span>
        ) : null}
        <CallSpace spaceId={cardSpaceOf(props)} />
        {durationMs !== undefined ? (
          <span className="shrink-0 text-xs tabular-nums">{formatDuration(durationMs, lang)}</span>
        ) : null}
        {phase === "error" ? (
          <FailedGlyph
            label={status === undefined ? t("tool.failed") : t("tool.failedHttp", { status })}
          />
        ) : null}
      </ActivityLine>
      {errorMsg ? (
        <p className="text-muted-foreground pb-1.5 pl-6 text-xs break-words">{errorMsg}</p>
      ) : null}
      <CollapsibleContent className={ACTIVITY_CONTENT_CLASS}>
        <div className={ACTIVITY_DETAIL_CLASS}>
          <div className="bg-card rounded-lg border p-3">
            <ToolCallDetail
              t={t}
              input={props.args}
              output={unwrapped}
              metadata={definedEntries({
                tool_call_id: props.toolCallId,
                is_error: props.isError,
                http_status: status,
                duration_ms: durationMs,
              })}
            />
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
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
          phase === "error" && !offer ? extractErrorMessage(unwrapMcpResult(result)) : undefined
        }
      />
    );
  }

  // Run launch (runAgent / runInline): the run's progress, for the call's whole life (launch,
  // stream, terminal, and launch failure, shown inside the panel).
  if (isRunLaunchOp(opId)) return <RunLaunchCard {...props} anchorsCall={false} />;

  const created =
    phase === "success" ? packageCreatedByOperation(opId, unwrapMcpResult(result)) : null;
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
      ? packageCreatedByImport(unwrapMcpResult(props.result))
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
