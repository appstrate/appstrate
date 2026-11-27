// SPDX-License-Identifier: Apache-2.0

/**
 * The model's reasoning, shown. The engine already streams it
 * (`reasoning-delta`, `pi-chat/ui-stream-mapper.ts`); assistant-ui's default
 * renderer for a reasoning part is `() => null`, and `GroupedParts` emits no
 * `indicator` part (the loading line) once the last part is reasoning, so
 * without this the bubble would stay blank for the whole reasoning phase.
 *
 * One disclosure per run of consecutive reasoning parts (`ReasoningGroup`),
 * open while that run is the part still streaming, so it takes the place the
 * thinking loader held, then folded to one line once the answer moves on. The
 * first click hands the open state to the reader for good. Settled, its trigger reads the
 * reasoning's first line.
 *
 * A running turn has ONE status region (`ThinkingStatus`). assistant-ui emits the `indicator` part
 * only while the message runs and its last part is neither text nor reasoning
 * (`MessageGroupedParts.js`, `shouldShowIndicator`, mode `no-text`): that is the loading line. A
 * reasoning tail draws it beside its `ReasoningGroup` trigger instead. A message ending in a folded
 * activity group (`endsFolded`) draws it beside that group's header: the loading line and the
 * reasoning row inside then draw none.
 */

import * as React from "react";
import { useAuiState, type ReasoningGroupComponent } from "@assistant-ui/react";
import { BrainIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@appstrate/ui/components/collapsible";
import { useChatHost } from "./runtime-context.ts";
import { DISCLOSURE_PANEL_CLASS, DISCLOSURE_TRIGGER_CLASS } from "./touch-targets.ts";
import { endsFolded, type GroupablePart } from "./conversation-tools.ts";
import { reasoningTitle } from "./turn-status.ts";
import { useTurnClock } from "./use-turn-clock.ts";

/** One full loop of the spark (each diagonal swaps twice), in ms (`.spark` in styles.css). */
const SPARK_LOOP_MS = 2400;

/**
 * The turn's one status region (the e2e/bench hook reads its test id): the
 * spark loader. h-6 = one prose-sm line: whatever replaces it shifts 0px.
 */
export function ThinkingStatus() {
  const { t } = useChatHost();
  // Every mount joins one clock, so the loader moving between the loading line
  // and a reasoning header mid-turn does not restart.
  const [phase] = React.useState(() => `${-(performance.now() % SPARK_LOOP_MS)}ms`);
  return (
    <div
      className="flex h-6 items-center"
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

/** The `indicator` part: the spark, the model thinking, the clock. One line, like what replaces it. */
export function LoadingLine() {
  const { t } = useChatHost();
  const deferred = useAuiState((s) => endsFolded(s.message.parts as readonly GroupablePart[]));
  const clock = useTurnClock(!deferred);
  if (deferred) return null;
  return (
    <div className="text-muted-foreground flex h-6 min-w-0 items-center gap-2 text-sm">
      <ThinkingStatus />
      <span className="min-w-0 truncate">{t("reasoning.running")}</span>
      {clock ? <span className="shrink-0 tabular-nums">{clock}</span> : null}
    </div>
  );
}

/** The first line of the reasoning parts from `start` to `end`, a string for `useAuiState`. */
function titleOf(parts: readonly { type: string; text?: string }[], start: number, end: number) {
  for (let i = start; i <= end; i++) {
    const part = parts[i];
    const title = part?.type === "reasoning" ? reasoningTitle(part.text ?? "") : "";
    if (title) return title;
  }
  return "";
}

/**
 * Running = message running ∧ this group is its tail, so the group settles once
 * a text or tool part follows, and on a turn stopped or failed mid-reasoning.
 */
export const ReasoningGroup: ReasoningGroupComponent = ({ startIndex, endIndex, children }) => {
  const { t } = useChatHost();
  const streaming = useAuiState(
    (s) => s.message.status?.type === "running" && s.message.parts.length - 1 === endIndex,
  );
  // A folded activity group around this one draws the status region in its header.
  const ownsStatus = useAuiState(
    (s) => streaming && !endsFolded(s.message.parts as readonly GroupablePart[]),
  );
  // Read once settled: a streaming row shows no title.
  const title = useAuiState((s) =>
    streaming
      ? ""
      : titleOf(
          s.message.parts as readonly { type: string; text?: string }[],
          startIndex,
          endIndex,
        ),
  );
  const [readerOpen, setReaderOpen] = React.useState<boolean | null>(null);
  const open = readerOpen ?? streaming;

  return (
    <Collapsible open={open} onOpenChange={setReaderOpen} className="my-2">
      <div className="flex min-w-0 items-center gap-2">
        <CollapsibleTrigger
          render={
            <Button variant="ghost" size="sm" className={`min-w-0 ${DISCLOSURE_TRIGGER_CLASS}`} />
          }
        >
          <BrainIcon />
          <span className="min-w-0 truncate">
            {streaming ? t("reasoning.running") : title || t("reasoning.done")}
          </span>
          <ChevronRightIcon className="duration-fast ease-surface transition-transform group-data-panel-open:rotate-90" />
        </CollapsibleTrigger>
        {/* A sibling of the trigger, not a child: a button's content is
            presentational, so a live region inside it is not exposed. It keeps
            something moving between the end of the reasoning and the next part. */}
        {ownsStatus ? <ThinkingStatus /> : null}
      </div>
      <CollapsibleContent className={DISCLOSURE_PANEL_CLASS}>
        <div className="border-border ml-2 border-l pl-4">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
};
