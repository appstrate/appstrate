// SPDX-License-Identifier: Apache-2.0

/**
 * The model's reasoning, shown (assistant-ui's default renderer for a reasoning part is
 * `() => null`). A run of consecutive reasoning parts is one step of its activity group
 * (`ReasoningStep`); it is open while it streams, until the reader's first click takes the state.
 *
 * A running turn has ONE status region (`ThinkingStatus`). assistant-ui emits the `indicator` part
 * only while the message runs and its last part is neither text nor reasoning
 * (`MessageGroupedParts.js`, `shouldShowIndicator`): that is the loading line. A message ending in
 * an activity group (`endsInActivity`) draws the region in that group's header instead, and the
 * loading line draws nothing.
 */

import * as React from "react";
import { useAuiState } from "@assistant-ui/react";
import { BrainIcon } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@appstrate/ui/components/collapsible";
import { useChatHost, type ChatTranslate } from "./runtime-context.ts";
import { endsInActivity, type GroupablePart } from "./conversation-tools.ts";
import { reasoningTitleAt, showStep } from "./turn-status.ts";
import { deriveToolPhase } from "./tool-result.ts";
import { useTurnClock } from "./use-turn-clock.ts";
import {
  ACTIVITY_BLOCK_CLASS,
  ACTIVITY_CONTENT_CLASS,
  ACTIVITY_DETAIL_CLASS,
  ActivityChevron,
  ActivityLabel,
  ActivityLine,
  ActivityTrigger,
} from "./activity-line.tsx";
import { useActivityMode } from "./activity-mode.ts";

/** A thread part as the loading line reads it. */
type ThreadPart = Parameters<typeof deriveToolPhase>[0] & {
  readonly type: string;
  readonly toolName?: string;
  readonly args?: unknown;
};

/** One full loop of the spark (each diagonal swaps twice), in ms (`.spark` in styles.css). */
const SPARK_LOOP_MS = 2400;

/**
 * The turn's one status region (the e2e/bench hook reads its test id): the spark loader, in an
 * activity line's lead slot, announcing `label`, the step in progress, as visually hidden text.
 */
export function ThinkingStatus({ label }: { label: string }) {
  // Every mount joins one clock, so the loader moving between the loading line
  // and a group's header mid-turn does not restart.
  const [phase] = React.useState(() => `${-(performance.now() % SPARK_LOOP_MS)}ms`);
  return (
    <span
      className="flex size-4 items-center justify-center"
      role="status"
      data-testid="chat-thinking-status"
    >
      <span aria-hidden className="spark" style={{ "--spark-phase": phase } as React.CSSProperties}>
        <i />
        <i />
        <i />
        <i />
      </span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** The call a message ends on while it runs (a run's line), named as the turn's step; "" otherwise. */
function runningCallLabel(parts: readonly ThreadPart[], t: ChatTranslate): string {
  const last = parts[parts.length - 1];
  if (last?.type !== "tool-call" || deriveToolPhase(last) !== "running") return "";
  return showStep(last, undefined, t).label;
}

/**
 * The `indicator` part: the spark, the clock, and what the turn is on (the call still running
 * above it, else the model thinking). One line, like what replaces it.
 */
export function LoadingLine() {
  const { t } = useChatHost();
  const deferred = useAuiState((s) => endsInActivity(s.message.parts as readonly GroupablePart[]));
  const step = useAuiState((s) => runningCallLabel(s.message.parts as readonly ThreadPart[], t));
  const clock = useTurnClock(!deferred);
  if (deferred) return null;
  const label = step || t("reasoning.running");
  return (
    <ActivityLine lead={<ThinkingStatus label={label} />} className={ACTIVITY_BLOCK_CLASS}>
      <ActivityLabel active>{label}</ActivityLabel>
      {clock ? (
        <span aria-hidden className="shrink-0 tabular-nums">
          {clock}
        </span>
      ) : null}
    </ActivityLine>
  );
}

/**
 * Streaming = message running ∧ this run is its tail, so the step settles once a text or tool
 * part follows, and on a turn stopped or failed mid-reasoning.
 */
export function ReasoningStep({
  indices,
  children,
}: {
  indices: readonly number[];
  children: React.ReactNode;
}) {
  const { t } = useChatHost();
  const solo = useActivityMode()?.solo ?? false;
  const streaming = useAuiState(
    (s) =>
      s.message.status?.type === "running" &&
      s.message.parts.length - 1 === indices[indices.length - 1],
  );
  const title = useAuiState((s) =>
    reasoningTitleAt(s.message.parts as readonly { type: string; text?: string }[], indices),
  );
  const [readerOpen, setReaderOpen] = React.useState<boolean | null>(null);

  if (solo) return <div className={ACTIVITY_DETAIL_CLASS}>{children}</div>;
  return (
    <Collapsible open={readerOpen ?? streaming} onOpenChange={setReaderOpen}>
      <ActivityLine lead={<BrainIcon aria-hidden />}>
        <CollapsibleTrigger render={<ActivityTrigger />}>
          <ActivityLabel active={streaming}>
            {title || t(streaming ? "reasoning.running" : "reasoning.done")}
          </ActivityLabel>
          <ActivityChevron />
        </CollapsibleTrigger>
      </ActivityLine>
      <CollapsibleContent className={ACTIVITY_CONTENT_CLASS}>
        <div className={ACTIVITY_DETAIL_CLASS}>{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}
