// SPDX-License-Identifier: Apache-2.0

/**
 * Appstrate-specific rich tool cards. Each MCP tool the chat agent calls gets
 * a compact row: icon, label, id, then the duration and, when the call failed, a small red
 * cross. The glanceable summary stays inline;
 * the full (technical) input/output is shown as raw JSON in a modal opened by
 * clicking the row — parsing arbitrary API payloads into a field table reads
 * worse than monospace JSON, and JSON keeps every field intact.
 *
 * A failure is softened, never hidden: its message stays inline under the header, muted, and a
 * small red cross ends the row; the HTTP status is in the call's detail. Tone is driven by the
 * actual result (`deriveToolPhase`), not the verb.
 *
 * One shared `<ToolCallCard>` does the work; the cards below name the call as the context panel
 * does (`showCall`). The thread picks a card by tool name (`thread.tsx`).
 * `invoke_operation` additionally short-circuits to the interactive
 * `OAuthConnectCard` when it kicks off an integration OAuth flow.
 */

import * as React from "react";
import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { ArrowUpRightIcon, BracesIcon, PlayIcon, XIcon, type LucideIcon } from "lucide-react";
import { formatDuration } from "@appstrate/core/format";
import { Button } from "@appstrate/ui/components/button";
import { Spinner } from "@appstrate/ui/components/spinner";
import { StructuredOutput } from "@appstrate/ui/components/structured-output";
import { Modal } from "./modal.tsx";
import { useChatHost } from "./runtime-context.ts";
import { ToolCallDetail } from "./tool-call-detail.tsx";
import { REVEAL_RING_CLASS, useRevealAnchor } from "./reveal-tool-call.ts";
import { OAuthConnectCard } from "./oauth-connect-card.tsx";
import { ChatRunProgressCard } from "./chat-run-progress-card.tsx";
import { CallSpace } from "./call-space.tsx";
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
import { showCall } from "./tool-presentation.ts";
import { cardSpaceOf, type StoredResult } from "./use-call-presentation.ts";
import { SubjectGlyph, SubjectStack } from "./subject-glyph.tsx";
import type { PresentationSubject } from "@appstrate/core/mcp-presentation";
import {
  definedEntries,
  deriveToolPhase,
  extractErrorMessage,
  httpStatusOf,
  type ToolPhase,
  unwrapToolResult,
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

/**
 * Single leading icon per row: the glyph of what the call acted on (an integration's
 * logo, an agent's tile) when the platform named it, else the verb icon, tinted by phase
 * (neutral, failed or not). While running it is replaced by a spinner. A failure is carried by
 * the muted error under the header and the cross at the row's end, never by the lead glyph.
 */
function LeadIcon({
  phase,
  Icon,
  subject,
}: {
  phase: ToolPhase;
  Icon: LucideIcon;
  subject?: PresentationSubject;
}) {
  if (phase === "running") {
    return <Spinner className="text-muted-foreground size-4 shrink-0" />;
  }
  if (subject) return <SubjectGlyph subject={subject} />;
  return <Icon className="text-muted-foreground size-4 shrink-0" />;
}

/**
 * Compact clickable tool row. Inline: lead icon, label, id, duration, the failure cross
 * (+ the muted inline error on failure). Click opens a modal with the raw input / output /
 * metadata JSON.
 */
export function ToolCallCard({
  phase,
  Icon,
  subject,
  label,
  idText,
  aside,
  args,
  result,
  isError,
  toolCallId,
  timing,
  spaceId,
  footer,
}: {
  phase: ToolPhase;
  Icon: LucideIcon;
  /** What the call acted on (`tool-presentation.ts`): its glyph is drawn instead of `Icon`. */
  subject?: PresentationSubject;
  /** What the call did, as `showCall` names it: shown verbatim, already translated. */
  label: string;
  idText?: string;
  /** Before the meta, e.g. a search's result count and the glyphs of what it found. */
  aside?: React.ReactNode;
  args: unknown;
  result: unknown;
  isError?: boolean;
  toolCallId: string;
  timing?: unknown;
  /** Where the call acted: the space stamped on it. */
  spaceId?: string;
  /** Under the header, e.g. the link to the package the call created. */
  footer?: React.ReactNode;
}) {
  const { t, lang } = useChatHost();
  const anchor = useRevealAnchor(toolCallId);
  const [open, setOpen] = React.useState(false);
  // `unwrapMcpResult` JSON-parses the tool payload. Unmemoized it re-parsed on
  // every render of this card — and during a stream the thread re-renders per
  // chunk, so a tool-heavy conversation paid it once per card per frame.
  const unwrapped = React.useMemo(() => unwrapToolResult(result), [result]);
  const status = httpStatusOf(unwrapped);
  const durationMs = readDurationMs(timing);
  const errorMsg = phase === "error" ? extractErrorMessage(unwrapped) : undefined;
  const meta = definedEntries({
    tool_call_id: toolCallId,
    is_error: isError,
    http_status: status,
    duration_ms: durationMs,
  });

  return (
    <div
      {...anchor}
      className={`bg-card text-card-foreground my-3 w-full rounded-lg border ${REVEAL_RING_CLASS}`}
    >
      {/* Fixed h-9 header row: the duration and the failure cross appear when the result
          lands — a py-based row would grow by a few px at that moment. Fixed height makes
          result arrival a 0px layout change. */}
      <button
        type="button"
        className="hover:bg-muted/50 flex h-9 w-full items-center gap-2 rounded-lg px-3 text-left text-sm"
        onClick={() => setOpen(true)}
      >
        <LeadIcon phase={phase} Icon={Icon} subject={subject} />
        {/* The id takes only the room left (basis 0): the name truncates once it has none. */}
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="min-w-0 truncate font-medium">{label}</span>
          {idText ? (
            <code className="text-muted-foreground min-w-0 flex-1 truncate text-xs">{idText}</code>
          ) : null}
        </span>
        {aside}
        <CallSpace spaceId={spaceId} />
        {durationMs !== undefined ? (
          <span className="text-muted-foreground text-xs">{formatDuration(durationMs, lang)}</span>
        ) : null}
        {phase === "error" ? (
          <FailedGlyph
            label={status === undefined ? t("tool.failed") : t("tool.failedHttp", { status })}
          />
        ) : null}
      </button>
      {errorMsg ? (
        <div className="text-muted-foreground border-t px-3 py-2 text-xs break-words">
          {errorMsg}
        </div>
      ) : null}
      {footer}
      {open ? (
        <Modal
          title={
            <span className="flex items-center gap-2">
              {subject ? <SubjectGlyph subject={subject} /> : <Icon className="size-4 shrink-0" />}
              {label}
              {idText ? <code className="text-muted-foreground text-xs">{idText}</code> : null}
            </span>
          }
          onClose={() => setOpen(false)}
        >
          <ToolCallDetail t={t} input={args} output={unwrapped} metadata={meta} />
        </Modal>
      ) : null}
    </div>
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
function RunLaunchCard(props: ToolCardProps): React.ReactNode {
  const { t } = useChatHost();
  const runId = extractRunId(props.result);
  const initialFiles = React.useMemo(() => extractRunFiles(props.result), [props.result]);
  // Same reason as `ToolCallCard` — see the note there.
  const unwrapped = React.useMemo(() => unwrapToolResult(props.result), [props.result]);
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
      toolCallId={props.toolCallId}
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

export function InvokeOperationTool(props: ToolCardProps) {
  const { t } = useChatHost();
  const { result } = props;
  const args = props.args as InvokeOperationArgs | undefined;
  const presentation = props.stored?.presentation;
  const opId = args?.operation_id ?? "";
  const phase = deriveToolPhase(props);

  // Connect kickoff → the interactive connect card, mounted from the FIRST
  // frame (before the result carries the connect/auth url) so the generic row
  // never swaps into the card mid-stream — a swap changes the block's height
  // and makes the transcript jump. On failure the card shows the error in
  // place (same geometry). Only the anomalous success-without-offer shape
  // falls through to the generic row.
  if (opId === INITIATE_CONNECT_OP) {
    // One card: the route behind this operation mints a single `connect_url`.
    const offer = extractAuthOffers(result)[0];
    if (offer || phase !== "success") {
      return (
        <OAuthConnectCard
          anchorsCall
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
  }

  // Run launch (runAgent / runInline) → rich in-chat run progress, mounted for
  // the tool call's whole life (launch, stream, terminal, and launch failure —
  // the error renders inside the panel). Never falls back to the generic card:
  // a component swap would change the block's height mid-stream.
  if (isRunLaunchOp(opId)) {
    return <RunLaunchCard {...props} />;
  }

  const shown = showCall({ toolName: "invoke_operation", args, presentation }, t);
  const spaceId = cardSpaceOf(props);
  const created =
    phase === "success" ? packageCreatedByOperation(opId, unwrapToolResult(result)) : null;
  return (
    <ToolCallCard
      phase={phase}
      {...shown}
      args={args}
      result={result}
      isError={props.isError}
      toolCallId={props.toolCallId}
      timing={props.timing}
      spaceId={spaceId}
      footer={
        created ? (
          <CreatedPackageLink created={created} toolCallId={props.toolCallId} spaceId={spaceId} />
        ) : null
      }
    />
  );
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
    <a
      href={href}
      className="text-primary hover:bg-muted/50 flex items-center gap-1.5 border-t px-3 py-2 text-xs font-medium"
    >
      <ArrowUpRightIcon className="size-3.5 shrink-0" />
      {t("tool.packageCreated.open")}
      <code className="text-muted-foreground truncate font-normal">{created.packageId}</code>
    </a>
  );
}

export function ImportPackageFileTool(props: ToolCardProps) {
  const { t } = useChatHost();
  const presentation = props.stored?.presentation;
  const phase = deriveToolPhase(props);
  const spaceId = cardSpaceOf(props);
  const created =
    phase === "success" ? packageCreatedByImport(unwrapToolResult(props.result)) : null;
  return (
    <ToolCallCard
      phase={phase}
      {...showCall({ ...props, presentation }, t)}
      args={props.args}
      result={props.result}
      isError={props.isError}
      toolCallId={props.toolCallId}
      timing={props.timing}
      spaceId={spaceId}
      footer={
        created ? (
          <CreatedPackageLink created={created} toolCallId={props.toolCallId} spaceId={spaceId} />
        ) : null
      }
    />
  );
}

export function SearchTool(props: ToolCardProps) {
  const { t } = useChatHost();
  const presentation = props.stored?.presentation;
  return (
    <ToolCallCard
      phase={deriveToolPhase(props)}
      {...showCall({ ...props, presentation }, t)}
      aside={
        presentation?.call === "search" ? (
          <span className="text-muted-foreground flex shrink-0 items-center gap-1.5 text-xs">
            <SubjectStack subjects={presentation.items} />
            {t("tool.search.count", { count: presentation.count })}
          </span>
        ) : null
      }
      args={props.args}
      result={props.result}
      isError={props.isError}
      toolCallId={props.toolCallId}
      timing={props.timing}
      spaceId={cardSpaceOf(props)}
    />
  );
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
      <RunLaunchCard {...props} />
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
