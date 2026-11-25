// SPDX-License-Identifier: Apache-2.0

/**
 * The agent's work on a turn, shown the way a coding agent shows it: its
 * reasoning and its tool calls fold into ONE block per run of consecutive steps
 * (`ThoughtGroup`, fed by `MessagePrimitive.GroupedParts` with the rule in
 * `thought-group.ts`). Collapsed it is one line: "Thinking", the step count,
 * the duration when the runtime timed it. Expanded it lists one compact row per
 * step, appended live.
 *
 * Open while the block is the part still streaming, so it takes the place the
 * thinking dots held, then folded once the answer moves on. The first click
 * hands the open state to the reader for good.
 *
 * Each step is one row that unfolds in place: a reasoning step reads as its
 * first line until opened (`ReasoningStep`), a tool call as its verb and target.
 * Inside the block a tool call is a quiet row (`useInThoughtGroup`): a failed
 * call the agent recovers from is a step, not a user-facing error. Red stays
 * for what ends the turn (`MessageError`).
 */

import * as React from "react";
import { useAuiState } from "@assistant-ui/react";
import { ChevronRightIcon, LightbulbIcon } from "lucide-react";
import { formatDuration } from "@appstrate/core/format";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@appstrate/ui/components/collapsible";
import { stepLabel } from "./thought-group.ts";
import { useTurnElapsedMs } from "./use-turn-elapsed.ts";
import { ReasoningText } from "./markdown-text.tsx";
import { useChatHost } from "./runtime-context.ts";
import { ThoughtGroupContext } from "./use-in-thought-group.ts";

/**
 * The turn's one status region (the e2e/bench hook reads its test id). h-6 =
 * one prose-sm line: whatever replaces it shifts 0px.
 */
/** One full loop of the spark (each diagonal swaps twice), in ms (`.spark` in styles.css). */
const SPARK_LOOP_MS = 2400;

export function ThinkingStatus() {
  const { t } = useChatHost();
  // Every mount joins one clock: the indicator moves between the loading line
  // and a thought block's header mid-turn, and restarting would show a jump.
  const [phase] = React.useState(() => `${-(performance.now() % SPARK_LOOP_MS)}ms`);
  return (
    <div
      className="flex h-6 shrink-0 items-center"
      role="status"
      aria-label={t("thinking.status")}
      data-testid="chat-thinking-status"
    >
      <span className="spark" style={{ "--spark-phase": phase } as React.CSSProperties}>
        <i />
        <i />
        <i />
        <i />
      </span>
    </div>
  );
}

/** The group summary `MessagePrimitive.GroupedParts` hands a `group-…` node. */
interface ThoughtGroupSummary {
  indices: readonly number[];
  timing?: { startedAt?: number; completedAt?: number };
}

function settledDurationMs(timing: ThoughtGroupSummary["timing"]): number | undefined {
  if (typeof timing?.startedAt !== "number" || typeof timing.completedAt !== "number") {
    return undefined;
  }
  return timing.completedAt - timing.startedAt;
}

/**
 * Running = message running and this block is its tail, so the block settles
 * once a text or a standalone card follows, and on a turn stopped or failed
 * mid-step.
 */
export function ThoughtGroup({
  group,
  children,
}: {
  group: ThoughtGroupSummary;
  children: React.ReactNode;
}) {
  const { t, lang } = useChatHost();
  const endIndex = group.indices[group.indices.length - 1];
  const streaming = useAuiState(
    (s) => s.message.status?.type === "running" && s.message.parts.length - 1 === endIndex,
  );
  // The step in progress, as one line: a plain string selector, never an object.
  const current = useAuiState((s) => {
    const part = endIndex === undefined ? undefined : s.message.parts[endIndex];
    if (part === undefined) return "";
    const label = stepLabel(part);
    return JSON.stringify([label.labelKey ?? "", label.label ?? "", label.target ?? ""]);
  });
  // Folded until the reader opens it, and then open for good: the agent's
  // progress never unfolds or folds the block under the reader.
  const [open, setOpen] = React.useState(false);
  const steps = group.indices.length;
  // Nothing to unfold while the agent only thinks: its one reasoning step is
  // what the header already says. The chevron comes with a second step.
  const expandable = !streaming || steps > 1;
  const elapsedMs = useTurnElapsedMs(streaming);
  const measuredMs = settledDurationMs(group.timing) ?? elapsedMs;
  // Under a second it would read "0 ms" at the start of every turn.
  const durationMs = measuredMs !== undefined && measuredMs >= 1000 ? measuredMs : undefined;

  // Live, the line reads like the loading line it replaces: the step in
  // progress ("Thinking…" during a reasoning step), the step count, the clock.
  // Settled: "Thinking", the step count, the time it took.
  let stepText = "";
  let stepTarget = "";
  if (streaming && current) {
    const [labelKey, label, target] = JSON.parse(current) as [string, string, string];
    stepText = labelKey ? t(labelKey) : label;
    stepTarget = target;
  }
  const time = durationMs !== undefined ? formatDuration(durationMs, lang) : null;
  const countText = steps > 1 ? t("reasoning.steps", { count: steps }) : null;
  // Claude Code's line, one plain sentence: what is happening now ("Thinking…"
  // during a reasoning step), the step count, then the time set apart.
  const sentence = (
    streaming
      ? [stepText || t("reasoning.running"), stepText ? stepTarget : "", countText]
      : [t("reasoning.done"), countText]
  )
    .filter(Boolean)
    .join(" ");

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="my-2">
      <div className="text-muted-foreground flex h-7 min-w-0 items-center gap-2 text-sm">
        {/* The dots sit beside the trigger, not in it: a button's content is
            presentational, so a live region inside it is not exposed. */}
        {streaming ? <ThinkingStatus /> : null}
        <CollapsibleTrigger asChild>
          <button
            type="button"
            disabled={!expandable}
            data-testid="chat-thought-toggle"
            className="enabled:hover:text-foreground group flex h-full min-w-0 items-center justify-start gap-2 text-left font-normal"
          >
            <span className="min-w-0 truncate">{sentence}</span>
            {time ? <span className="shrink-0 tabular-nums">{time}</span> : null}
            {expandable ? (
              <ChevronRightIcon className="duration-fast ease-surface size-4 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
            ) : null}
          </button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent className="duration-base ease-surface motion-safe:data-[state=open]:animate-collapsible-down motion-safe:data-[state=closed]:animate-collapsible-up overflow-hidden">
        {/* One row per step, Claude Code's way. */}
        <div className="bg-card mt-1 flex flex-col divide-y overflow-hidden rounded-lg border">
          <ThoughtGroupContext.Provider value={true}>{children}</ThoughtGroupContext.Provider>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** First line of a reasoning text, markdown marks dropped: the step's one-line summary. */
function reasoningExcerpt(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.replace(/[*_`#>]/g, "").trim();
}

/** A reasoning step in the thought block: its first line, the full text one click away. */
export function ReasoningStep({ text }: { text: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="w-full">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="hover:bg-muted/40 text-muted-foreground hover:text-foreground flex h-9 w-full items-center justify-start gap-2 px-3 text-left text-sm font-normal"
      >
        <LightbulbIcon className="size-4 shrink-0" />
        <span className="min-w-0 truncate">{reasoningExcerpt(text)}</span>
        <ChevronRightIcon
          className={`size-3.5 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
        />
      </button>
      {open ? (
        <div className="bg-muted/30 border-t px-3 py-2 text-sm">
          <ReasoningText />
        </div>
      ) : null}
    </div>
  );
}
