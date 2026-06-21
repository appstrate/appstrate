// SPDX-License-Identifier: Apache-2.0

/**
 * Appstrate-specific tool UIs — richer than the generic ToolFallback for the
 * calls a user actually cares about. Registered by mounting the components
 * (once) inside the runtime provider; the thread's `part.toolUI` then picks
 * them up in place of the fallback card.
 *
 * `wait_for_run` is the highest-value case: it blocks for up to minutes while
 * a delegated agent runs, so we show live "running" feedback and a clear final
 * verdict instead of an opaque "tool" row. The MCP meta-tools
 * (search/describe/invoke_operation) stay on the fallback — they're plumbing.
 */

import { makeAssistantToolUI } from "@assistant-ui/react";
import {
  CheckCircle2Icon,
  ClockIcon,
  Code2Icon,
  Loader2Icon,
  Maximize2Icon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
  XCircleIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react";
import { useOpenArtifact } from "./artifact-panel.tsx";

interface WaitForRunArgs {
  run_id: string;
}

// Only the fields this card reads; the error case is detected by the absence
// of a terminal `status` (it falls through to the error tone below).
interface WaitForRunResult {
  run_id: string;
  status?: string;
  waited_seconds?: number;
  timed_out?: boolean;
  aborted?: boolean;
}

type Tone = "muted" | "success" | "error";

const TONE_CLASS: Record<Tone, string> = {
  muted: "text-muted-foreground",
  success: "text-primary",
  error: "text-destructive",
};

/** Map the (running, result) pair to an icon + French label + tone. */
function describeRun(
  running: boolean,
  result: WaitForRunResult | undefined,
): { Icon: LucideIcon; label: string; tone: Tone; spin?: boolean } {
  if (running || !result)
    return { Icon: Loader2Icon, label: "Exécution du run en cours…", tone: "muted", spin: true };
  if (result.aborted) return { Icon: XCircleIcon, label: "Run interrompu", tone: "muted" };
  if (result.timed_out)
    return {
      Icon: ClockIcon,
      label: `Run toujours en cours (attendu ${result.waited_seconds ?? "?"} s)`,
      tone: "muted",
    };
  if (result.status === "success")
    return { Icon: CheckCircle2Icon, label: "Run terminé avec succès", tone: "success" };
  return {
    Icon: XCircleIcon,
    label: `Run ${result.status ?? "en échec"}`,
    tone: "error",
  };
}

/**
 * Inline artifact: a minimal, non-interactive card (Claude/ChatGPT style).
 * Clicking it opens the real interactive rendering in the side panel — the
 * iframe lives only there, so the thread stays light and the HTML runs once.
 */
function ArtifactCard({
  code,
  title,
  streaming,
}: {
  code: string;
  title?: string;
  streaming: boolean;
}) {
  const openArtifact = useOpenArtifact();
  if (streaming)
    return (
      <ToolLine
        Icon={Loader2Icon}
        iconClass="text-muted-foreground animate-spin"
        label="Génération de l’artifact…"
        muted
      />
    );
  return (
    <button
      type="button"
      onClick={() => openArtifact?.({ code, title })}
      className="bg-card text-card-foreground hover:bg-accent/50 mb-3 flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors"
    >
      <span className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-md">
        <Code2Icon className="text-muted-foreground size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{title ?? "Artifact HTML"}</span>
        <span className="text-muted-foreground block text-xs">Cliquer pour ouvrir</span>
      </span>
      <Maximize2Icon className="text-muted-foreground size-4 shrink-0" />
    </button>
  );
}

export const RenderHtmlToolUI = makeAssistantToolUI<{ code?: string; title?: string }, unknown>({
  toolName: "render_html",
  // Surface the artifact on its own — never folded into the "tools N appels"
  // group (the thread's groupBy routes standalone tool calls outside the pli).
  display: "standalone",
  render: ({ args, status }) => (
    <ArtifactCard
      code={args?.code ?? ""}
      title={args?.title}
      streaming={status.type === "running"}
    />
  ),
});

/** Compact one-line tool card: status icon · label · trailing id (mono). */
function ToolLine({
  Icon,
  iconClass,
  label,
  muted,
  trailing,
}: {
  Icon: LucideIcon;
  iconClass: string;
  label: string;
  muted?: boolean;
  trailing?: string;
}) {
  return (
    <div className="bg-card text-card-foreground mb-3 flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-sm">
      <Icon className={`size-4 shrink-0 ${iconClass}`} />
      <span className={`flex-1 truncate ${muted ? "text-muted-foreground" : ""}`}>{label}</span>
      {trailing ? <code className="text-muted-foreground shrink-0 text-xs">{trailing}</code> : null}
    </div>
  );
}

export const WaitForRunToolUI = makeAssistantToolUI<WaitForRunArgs, WaitForRunResult>({
  toolName: "wait_for_run",
  render: ({ args, result, status }) => {
    const { Icon, label, tone, spin } = describeRun(status.type === "running", result);
    return (
      <ToolLine
        Icon={Icon}
        iconClass={`${TONE_CLASS[tone]} ${spin ? "animate-spin" : ""}`}
        label={label}
        trailing={result?.run_id ?? args?.run_id}
      />
    );
  },
});

// Readable label + icon for an Appstrate API operation, by verb prefix — a
// heuristic, not an exhaustive operationId map (which would rot). The first
// matching rule wins; unmatched ids fall back to a neutral "Opération".
const OP_RULES: { re: RegExp; label: string; tone: Tone; Icon: LucideIcon }[] = [
  { re: /^(run|trigger|execute|start)/i, label: "Lancement", tone: "success", Icon: PlayIcon },
  { re: /^(create|post|add|import|upload)/i, label: "Création", tone: "success", Icon: PlusIcon },
  { re: /^(update|patch|put|set|rename|configure)/i, label: "Modification", tone: "muted", Icon: PencilIcon }, // prettier-ignore
  { re: /^(delete|remove|cancel|archive)/i, label: "Suppression", tone: "error", Icon: Trash2Icon },
  { re: /^(list|get|search|find|read)/i, label: "Lecture", tone: "muted", Icon: SearchIcon },
];

export const InvokeOperationToolUI = makeAssistantToolUI<{ operation_id?: string }, unknown>({
  toolName: "invoke_operation",
  render: ({ args, status }) => {
    const opId = args?.operation_id ?? "";
    const rule = OP_RULES.find((r) => r.re.test(opId)) ?? {
      Icon: ZapIcon,
      label: "Opération",
      tone: "muted" as Tone,
    };
    const running = status.type === "running";
    return (
      <ToolLine
        Icon={running ? Loader2Icon : rule.Icon}
        iconClass={running ? "text-muted-foreground animate-spin" : TONE_CLASS[rule.tone]}
        label={rule.label}
        muted
        trailing={opId}
      />
    );
  },
});
