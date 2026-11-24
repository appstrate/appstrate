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
 * Inside the block a tool call is a quiet row (`useInThoughtGroup`): a failed
 * call the agent recovers from is a step, not a user-facing error. Red stays
 * for what ends the turn (`MessageError`).
 */

import * as React from "react";
import { useAuiState } from "@assistant-ui/react";
import { BrainIcon, ChevronRightIcon } from "lucide-react";
import { formatDuration } from "@appstrate/core/format";
import { Button } from "@appstrate/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@appstrate/ui/components/collapsible";
import { useChatHost } from "./runtime-context.ts";
import { ThoughtGroupContext } from "./use-in-thought-group.ts";

/**
 * The turn's one status region (the e2e/bench hook reads its test id). h-6 =
 * one prose-sm line: whatever replaces it shifts 0px.
 */
export function ThinkingStatus() {
  const { t } = useChatHost();
  return (
    <div
      className="flex h-6 items-center gap-1"
      role="status"
      aria-label={t("thinking.status")}
      data-testid="chat-thinking-status"
    >
      <span className="bg-muted-foreground/70 size-1.5 animate-bounce rounded-full [animation-delay:-0.3s] motion-reduce:animate-pulse" />
      <span className="bg-muted-foreground/70 size-1.5 animate-bounce rounded-full [animation-delay:-0.15s] motion-reduce:animate-pulse" />
      <span className="bg-muted-foreground/70 size-1.5 animate-bounce rounded-full motion-reduce:animate-pulse" />
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
  const [readerOpen, setReaderOpen] = React.useState<boolean | null>(null);
  const open = readerOpen ?? streaming;
  const steps = group.indices.length;
  const durationMs = streaming ? undefined : settledDurationMs(group.timing);
  const summary = [
    steps > 1 ? t("reasoning.steps", { count: steps }) : null,
    durationMs !== undefined ? formatDuration(durationMs, lang) : null,
  ].filter((part) => part !== null);

  return (
    <Collapsible open={open} onOpenChange={setReaderOpen} className="my-2">
      <div className="flex items-center gap-2">
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground group -ml-2 gap-1.5 px-2"
          >
            <BrainIcon />
            {streaming ? t("reasoning.running") : t("reasoning.done")}
            {summary.length > 0 ? (
              <span className="text-muted-foreground/80 font-normal tabular-nums">
                {summary.join(" · ")}
              </span>
            ) : null}
            <ChevronRightIcon className="duration-fast ease-surface transition-transform group-data-[state=open]:rotate-90" />
          </Button>
        </CollapsibleTrigger>
        {/* A sibling of the trigger, not a child: a button's content is
            presentational, so a live region inside it is not exposed. It keeps
            something moving while the agent works between two visible parts. */}
        {streaming ? <ThinkingStatus /> : null}
      </div>
      <CollapsibleContent className="duration-base ease-surface motion-safe:data-[state=open]:animate-collapsible-down motion-safe:data-[state=closed]:animate-collapsible-up overflow-hidden">
        {/* A click on a step (its detail modal) is the reader's too: the block
            stays as they see it when the answer starts. */}
        <div
          className="border-border ml-2 flex flex-col border-l pl-3"
          onClickCapture={() => setReaderOpen((current) => current ?? open)}
        >
          <ThoughtGroupContext.Provider value={true}>{children}</ThoughtGroupContext.Provider>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
