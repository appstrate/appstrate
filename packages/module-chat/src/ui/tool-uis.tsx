// SPDX-License-Identifier: Apache-2.0

/**
 * Appstrate-specific rich tool cards. Each MCP tool the chat agent calls gets
 * a compact, error-aware row: phase icon + verb icon + label + id, with the
 * HTTP status and duration on the right. The glanceable summary stays inline;
 * the full (technical) input/output is shown as raw JSON in a modal opened by
 * clicking the row — parsing arbitrary API payloads into a field table reads
 * worse than monospace JSON, and JSON keeps every field intact.
 *
 * Errors stay inline (banner under the header), never hidden behind the click.
 * Tone is driven by the actual result (`deriveToolPhase`), not the verb — a
 * failed call always renders as an error.
 *
 * One shared `<ToolCallCard>` does the work; the four `makeAssistantToolUI`
 * registrations are thin wrappers that only pick the icon, label, and id.
 * `invoke_operation` additionally short-circuits to the interactive
 * `OAuthConnectCard` when it kicks off an integration OAuth flow.
 */

import * as React from "react";
import { makeAssistantToolUI, type ToolCallMessagePartProps } from "@assistant-ui/react";
import {
  BookOpenIcon,
  Loader2Icon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
  UserIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react";
import { Modal } from "./modal.tsx";
import { JsonView } from "./json-view.tsx";
import { OAuthConnectCard } from "./oauth-connect-card.tsx";
import { RunPanel } from "./run-panel.tsx";
import { extractAgentLabel, extractRunId, extractRunStatus, isRunLaunchOp } from "./run-events.ts";
import { extractAuthOffer } from "./auth-offer.ts";
import {
  asRecord,
  definedEntries,
  deriveToolPhase,
  extractErrorMessage,
  httpStatusOf,
  unwrapResult,
  type ToolPhase,
} from "./tool-result.ts";

/**
 * `invoke_operation` operationId that kicks off an integration connect flow.
 * `initiateIntegrationConnect` is the unified, auth-type-agnostic op (issue
 * #769) whose result carries a `connect_url`; its result renders the connect
 * card (button + auto-resume on completion — see oauth-connect-card).
 */
const INITIATE_CONNECT_OP = "initiateIntegrationConnect";

// Readable label + icon for an Appstrate API operation, by verb prefix — a
// heuristic, not an exhaustive operationId map (which would rot). The first
// match wins; unmatched ops fall back to the neutral "Opération".
const OP_RULES: { re: RegExp; label: string; Icon: LucideIcon }[] = [
  { re: /^(run|trigger|execute|start)/i, label: "Lancement", Icon: PlayIcon },
  { re: /^(create|post|add|import|upload)/i, label: "Création", Icon: PlusIcon },
  { re: /^(update|patch|put|set|rename|configure)/i, label: "Modification", Icon: PencilIcon },
  { re: /^(delete|remove|cancel|archive)/i, label: "Suppression", Icon: Trash2Icon },
  { re: /^(list|get|search|find|read)/i, label: "Lecture", Icon: SearchIcon },
];

// assistant-stream ToolCallTiming = { startedAt, completedAt? } (epoch ms;
// completedAt absent while running).
function readDurationMs(timing: unknown): number | undefined {
  const t = asRecord(timing);
  if (t && typeof t.startedAt === "number" && typeof t.completedAt === "number") {
    return t.completedAt - t.startedAt;
  }
  return undefined;
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

const BADGE_TONE: Record<ToolPhase, string> = {
  success: "bg-primary/10 text-primary",
  error: "bg-destructive/10 text-destructive",
  running: "bg-muted text-muted-foreground",
  pending: "bg-muted text-muted-foreground",
};

function Meta({
  phase,
  status,
  durationMs,
}: {
  phase: ToolPhase;
  status?: number;
  durationMs?: number;
}) {
  if (status === undefined && durationMs === undefined) return null;
  return (
    <span className="flex items-center gap-1.5 text-xs">
      {status !== undefined ? (
        <code className={`rounded px-1.5 py-0.5 font-medium ${BADGE_TONE[phase]}`}>{status}</code>
      ) : null}
      {durationMs !== undefined ? (
        <span className="text-muted-foreground">{formatMs(durationMs)}</span>
      ) : null}
    </span>
  );
}

/**
 * Single leading icon per row: the operation's verb icon, tinted by phase
 * (neutral / destructive). While running it is replaced by a spinner. Status is
 * otherwise carried by the HTTP badge, the red border, and the inline error —
 * no separate status icon, so the row shows one coherent glyph.
 */
function LeadIcon({ phase, Icon }: { phase: ToolPhase; Icon: LucideIcon }) {
  if (phase === "running") {
    return <Loader2Icon className="text-muted-foreground size-4 shrink-0 animate-spin" />;
  }
  const tone = phase === "error" ? "text-destructive" : "text-muted-foreground";
  return <Icon className={`size-4 shrink-0 ${tone}`} />;
}

function hasContent(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return false;
  const rec = asRecord(value);
  if (rec) return Object.keys(rec).length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function DetailSection({ title, value }: { title: string; value: unknown }) {
  if (!hasContent(value)) return null;
  return (
    <div className="space-y-1">
      <div className="text-muted-foreground text-[0.65rem] font-semibold tracking-wide uppercase">
        {title}
      </div>
      <JsonView value={value} />
    </div>
  );
}

/**
 * Compact clickable tool row. Inline: phase icon, verb icon, label, id, and
 * HTTP/duration meta (+ an inline error banner on failure). Click opens a modal
 * with the raw input / output / metadata JSON.
 */
export function ToolCallCard({
  phase,
  Icon,
  label,
  idText,
  args,
  result,
  isError,
  toolCallId,
  artifact,
  timing,
}: {
  phase: ToolPhase;
  Icon: LucideIcon;
  label: string;
  idText?: string;
  args: unknown;
  result: unknown;
  isError?: boolean;
  toolCallId: string;
  artifact?: unknown;
  timing?: unknown;
}) {
  const [open, setOpen] = React.useState(false);
  const unwrapped = unwrapResult(result);
  const status = httpStatusOf(unwrapped);
  const durationMs = readDurationMs(timing);
  const errorMsg = phase === "error" ? extractErrorMessage(unwrapped) : undefined;
  const meta = definedEntries({
    tool_call_id: toolCallId,
    is_error: isError,
    http_status: status,
    duration_ms: durationMs,
    artifact,
  });

  const border = phase === "error" ? "border-destructive/40" : "";
  return (
    <div className={`bg-card text-card-foreground my-3 w-full rounded-lg border ${border}`}>
      <button
        type="button"
        className="hover:bg-muted/40 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm"
        onClick={() => setOpen(true)}
      >
        <LeadIcon phase={phase} Icon={Icon} />
        <span className="flex min-w-0 flex-1 items-center gap-2 truncate">
          <span className="font-medium">{label}</span>
          {idText ? <code className="text-muted-foreground truncate text-xs">{idText}</code> : null}
        </span>
        <Meta phase={phase} status={status} durationMs={durationMs} />
      </button>
      {errorMsg ? (
        <div className="text-destructive border-t px-3 py-2 text-xs break-words">{errorMsg}</div>
      ) : null}
      {open ? (
        <Modal
          title={
            <span className="flex items-center gap-2">
              <Icon className="size-4 shrink-0" />
              {label}
              {idText ? <code className="text-muted-foreground text-xs">{idText}</code> : null}
            </span>
          }
          onClose={() => setOpen(false)}
        >
          <div className="space-y-4">
            <DetailSection title="Entrée" value={args} />
            <DetailSection title="Sortie" value={unwrapped} />
            <DetailSection title="Métadonnées" value={meta} />
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

type AnyToolProps = ToolCallMessagePartProps<Record<string, unknown>, unknown>;

export const InvokeOperationToolUI = makeAssistantToolUI<
  { operation_id?: string; path_params?: { packageId?: string } } & Record<string, unknown>,
  unknown
>({
  toolName: "invoke_operation",
  render: (props) => {
    const { args, result } = props;
    const opId = args?.operation_id ?? "";

    // Connect kickoff → render an interactive connect card (button + auto-resume)
    // once the result carries the connect/auth url. Until then, fall through to
    // the generic running line.
    if (opId === INITIATE_CONNECT_OP) {
      const offer = extractAuthOffer(result);
      if (offer) {
        return (
          <OAuthConnectCard
            authUrl={offer.authUrl}
            state={offer.state}
            packageId={args?.path_params?.packageId}
          />
        );
      }
    }

    const rule = OP_RULES.find((r) => r.re.test(opId)) ?? { Icon: ZapIcon, label: "Opération" };
    const card = (
      <ToolCallCard
        phase={deriveToolPhase(props)}
        Icon={rule.Icon}
        label={rule.label}
        idText={opId}
        args={args}
        result={result}
        isError={props.isError}
        toolCallId={props.toolCallId}
        artifact={props.artifact}
        timing={props.timing}
      />
    );

    // Run launch (runAgent / runInline / run_and_wait) → wrap the card in a
    // panel that tails the launched run's logs live once the result carries a
    // `run_…` id. A failed launch (no id) renders the bare card unchanged.
    if (isRunLaunchOp(opId) && !props.isError) {
      const runId = extractRunId(result);
      if (runId) {
        return (
          <RunPanel
            runId={runId}
            initialStatus={extractRunStatus(result)}
            agentLabel={extractAgentLabel(args)}
            header={card}
          />
        );
      }
    }

    return card;
  },
});

function stringArg(args: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = args?.[key];
  return typeof v === "string" && v ? v : undefined;
}

export const SearchOperationsToolUI = makeAssistantToolUI<Record<string, unknown>, unknown>({
  toolName: "search_operations",
  render: (props: AnyToolProps) => (
    <ToolCallCard
      phase={deriveToolPhase(props)}
      Icon={SearchIcon}
      label="Recherche d'opérations"
      idText={stringArg(props.args, "query")}
      args={props.args}
      result={props.result}
      isError={props.isError}
      toolCallId={props.toolCallId}
      artifact={props.artifact}
      timing={props.timing}
    />
  ),
});

export const DescribeOperationToolUI = makeAssistantToolUI<Record<string, unknown>, unknown>({
  toolName: "describe_operation",
  render: (props: AnyToolProps) => (
    <ToolCallCard
      phase={deriveToolPhase(props)}
      Icon={BookOpenIcon}
      label="Description d'opération"
      idText={stringArg(props.args, "operation_id")}
      args={props.args}
      result={props.result}
      isError={props.isError}
      toolCallId={props.toolCallId}
      artifact={props.artifact}
      timing={props.timing}
    />
  ),
});

export const GetMeToolUI = makeAssistantToolUI<Record<string, unknown>, unknown>({
  toolName: "get_me",
  render: (props: AnyToolProps) => (
    <ToolCallCard
      phase={deriveToolPhase(props)}
      Icon={UserIcon}
      label="Contexte utilisateur"
      args={props.args}
      result={props.result}
      isError={props.isError}
      toolCallId={props.toolCallId}
      artifact={props.artifact}
      timing={props.timing}
    />
  ),
});

// `run_and_wait` is its own MCP tool (not invoke_operation), so it needs its
// own UI. While it blocks (no result yet) the generic launch card shows; once
// it returns a `run_…` id, the rich RunPanel takes over (agent name, live
// status, latest log line). A still-running run (`done:false` early return)
// keeps streaming over SSE.
export const RunAndWaitToolUI = makeAssistantToolUI<Record<string, unknown>, unknown>({
  toolName: "run_and_wait",
  render: (props: AnyToolProps) => {
    const card = (
      <ToolCallCard
        phase={deriveToolPhase(props)}
        Icon={PlayIcon}
        label="Lancement"
        idText={stringArg(props.args, "kind")}
        args={props.args}
        result={props.result}
        isError={props.isError}
        toolCallId={props.toolCallId}
        artifact={props.artifact}
        timing={props.timing}
      />
    );
    if (!props.isError) {
      const runId = extractRunId(props.result);
      if (runId) {
        return (
          <RunPanel
            runId={runId}
            initialStatus={extractRunStatus(props.result)}
            agentLabel={extractAgentLabel(props.args)}
            header={card}
          />
        );
      }
    }
    return card;
  },
});
