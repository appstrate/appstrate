// SPDX-License-Identifier: Apache-2.0

/**
 * What the assistant did between two texts, on one line: its reasoning and its tool calls, one
 * step or twenty (`activityGroupOf`). A group of one call is that call's line from its first chunk
 * on (`ThreadCallLine`): a click opens it in the context panel, nothing to unfold; its lead is the
 * spark while the turn runs, its icon once settled. Any other group is a disclosure: opened, a rail
 * of steps, a reasoning reading in place, a call a line opening it in the panel. A group of one
 * reasoning opens straight on its text, the line naming it. A call the context panel reveals
 * (`reveal-tool-call.ts`) opens its group: a folded one does not mount its steps.
 *
 * Ending the running message, the line is the turn's status: the spark (the status region, beside
 * the control, saying the step in progress), the step in progress, the turn's clock. Settled, it
 * names its one call, or counts them (« 3 consultations · 1 action »), failures apart; a group of
 * reasoning alone reads its first line, and is a plain line, nothing to open, when its text says
 * nothing more.
 *
 * `children` is drawn twice: as steps under the rail, and as what must stay in view whatever the
 * fold (`activity-mode.ts`, "breakout": a connect card, a launched run, a created package's link).
 * The breakout keeps one place in the tree for the group's whole life, whatever its line becomes,
 * so what it holds never remounts.
 */

import * as React from "react";
import { useAuiState } from "@assistant-ui/react";
import { BrainIcon, EyeIcon, ListTreeIcon } from "lucide-react";
import type { PresentationSubject } from "@appstrate/core/mcp-presentation";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@appstrate/ui/components/collapsible";
import { useChatHost, type ChatTranslate } from "./runtime-context.ts";
import { SubjectGlyph, SubjectStack } from "./subject-glyph.tsx";
import {
  activityCounts,
  callsAt,
  isStampedLookup,
  type GroupablePart,
} from "./conversation-tools.ts";
import { ThinkingStatus } from "./reasoning.tsx";
import { useTurnClock } from "./use-turn-clock.ts";
import {
  isCallInProgress,
  reasoningSaysMore,
  reasoningTitle,
  reasoningTitleAt,
  showStep,
} from "./turn-status.ts";
import { showCall } from "./tool-presentation.ts";
import { deriveToolPhase } from "./tool-result.ts";
import type { StoredResults } from "./use-call-presentation.ts";
import { presentationSubject } from "./tool-presentation.ts";
import { forgetRevealedToolCalls, useRevealedToolCalls } from "./reveal-tool-call.ts";
import { ThreadCallLine } from "./tool-uis.tsx";
import {
  ACTIVITY_BLOCK_CLASS,
  ACTIVITY_CONTENT_CLASS,
  ActivityChevron,
  ActivityId,
  ActivityLabel,
  ActivityLine,
  ActivityRail,
  ActivityTrigger,
  FailedGlyph,
} from "./activity-line.tsx";
import { ActivityModeContext, type ActivityMode } from "./activity-mode.ts";

/** A thread part as the header reads it. */
type StepPart = GroupablePart & {
  readonly toolName?: string;
  readonly args?: unknown;
  readonly text?: string;
};

interface StepMessage {
  readonly status?: { readonly type: string };
  readonly parts: readonly unknown[];
}

/** What the group's line reads off its parts. */
interface GroupFacts {
  readonly ids: readonly string[];
  /** The part index of the group's one call. */
  readonly onlyIndex?: number;
  readonly lookups: number;
  readonly failed: number;
  /** Each run of consecutive reasoning parts is one step. */
  readonly reasoningRuns: number;
  /** The group ends the running message. */
  readonly running: boolean;
  /** The step in progress while running. */
  readonly step?: { label: string; idText?: string };
  /** A settled group of reasoning alone: its first line, and whether its text says more. */
  readonly title: string;
  readonly saysMore: boolean;
}

function groupFacts(
  message: StepMessage,
  indices: readonly number[],
  stored: StoredResults,
  t: ChatTranslate,
): GroupFacts {
  const parts = message.parts as readonly StepPart[];
  const lastIndex = indices[indices.length - 1];
  const running = message.status?.type === "running" && parts.length - 1 === lastIndex;
  const calls = callsAt(parts, indices);
  let reasoningRuns = 0;
  let inRun = false;
  for (const i of indices) {
    const reasoning = parts[i]?.type === "reasoning";
    if (reasoning && !inRun) reasoningRuns += 1;
    inRun = reasoning;
  }
  const reasoningAlone = calls.length === 0 && !running;
  return {
    ids: calls.map((part) => part.toolCallId ?? ""),
    onlyIndex: calls.length === 1 ? indices.find((i) => parts[i] === calls[0]) : undefined,
    lookups: calls.filter(isStampedLookup).length,
    failed: calls.filter((part) => deriveToolPhase(part) === "error").length,
    reasoningRuns,
    running,
    step: running ? stepInProgress(parts[lastIndex ?? -1], stored, t) : undefined,
    title: reasoningAlone ? reasoningTitleAt(parts, indices) : "",
    saysMore:
      reasoningAlone &&
      reasoningSaysMore(
        indices
          .map((i) => (parts[i]?.type === "reasoning" ? (parts[i]?.text ?? "") : ""))
          .join("\n"),
      ),
  };
}

const BREAKOUT_MODE: ActivityMode = { mode: "breakout", solo: false };

export function ActivityGroup({
  indices,
  stored,
  children,
}: {
  indices: readonly number[];
  stored: StoredResults;
  children: React.ReactNode;
}) {
  const { t } = useChatHost();
  // One walk per store update, serialized: a string changes only when a fact does, where a fresh
  // object would re-render the group on every chunk.
  const factsKey = useAuiState((s) => JSON.stringify(groupFacts(s.message, indices, stored, t)));
  const facts = React.useMemo(() => JSON.parse(factsKey) as GroupFacts, [factsKey]);
  const { ids: callIds, onlyIndex, lookups, failed, reasoningRuns, running, title } = facts;
  // The group's one call, as the thread holds it: an existing object, so a stable selection.
  const onlyCall = useAuiState((s) =>
    onlyIndex === undefined ? undefined : (s.message.parts[onlyIndex] as StepPart | undefined),
  );
  const calls = callIds.length;
  const stepLabel = facts.step?.label ?? "";
  const subjects = React.useMemo(
    () =>
      callIds.flatMap((id): PresentationSubject[] => {
        const subject = presentationSubject(stored.get(id)?.presentation);
        return subject ? [subject] : [];
      }),
    [callIds, stored],
  );
  const { opened } = useRevealedToolCalls();
  const revealed = callIds.some((id) => opened.has(id));
  const [readerOpen, setReaderOpen] = React.useState(false);
  const clock = useTurnClock(running);
  const onOpenChange = (open: boolean) => {
    setReaderOpen(open);
    if (!open) forgetRevealedToolCalls(callIds);
  };

  const only =
    onlyCall?.toolName !== undefined
      ? showCall(
          {
            toolName: onlyCall.toolName,
            args: onlyCall.args,
            presentation: onlyCall.toolCallId
              ? stored.get(onlyCall.toolCallId)?.presentation
              : undefined,
          },
          t,
        )
      : undefined;
  const solo = calls + reasoningRuns === 1;
  const stepMode = React.useMemo((): ActivityMode => ({ mode: "step", solo }), [solo]);
  const actions = calls - lookups;

  const lead = running ? (
    <ThinkingStatus label={stepLabel} />
  ) : only ? (
    only.subject ? (
      <SubjectGlyph subject={only.subject} />
    ) : (
      <only.Icon aria-hidden />
    )
  ) : calls === 0 ? (
    <BrainIcon aria-hidden />
  ) : actions === 0 ? (
    <EyeIcon aria-hidden />
  ) : (
    <ListTreeIcon aria-hidden />
  );

  const steps = <ActivityModeContext value={stepMode}>{children}</ActivityModeContext>;
  const loneCallId = solo && only ? callIds[0] : undefined;

  const line =
    onlyCall && only && loneCallId ? (
      // A lone call is its own line for its whole life: a click opens it in the panel.
      <ThreadCallLine
        call={{ ...onlyCall, toolCallId: loneCallId, stored: stored.get(loneCallId) }}
        lead={lead}
        label={only.label}
        idText={only.idText}
        running={isCallInProgress(onlyCall)}
      />
    ) : calls === 0 && !running && !facts.saysMore ? (
      // Reasoning that says nothing past its title: the disclosure's line without its trigger.
      <ActivityLine lead={lead}>
        <ActivityLabel>{title || t("reasoning.done")}</ActivityLabel>
      </ActivityLine>
    ) : (
      <Collapsible open={readerOpen || revealed} onOpenChange={onOpenChange}>
        {/* The spark is a sibling of the trigger: a live region inside a button is not exposed. */}
        <ActivityLine lead={lead}>
          <CollapsibleTrigger render={<ActivityTrigger />}>
            {running ? (
              <>
                <ActivityLabel active>{stepLabel}</ActivityLabel>
                {facts.step?.idText ? <ActivityId>{facts.step.idText}</ActivityId> : null}
              </>
            ) : calls === 0 ? (
              <ActivityLabel>{title || t("reasoning.done")}</ActivityLabel>
            ) : (
              <span className="shrink-0">{activityCounts(t, { lookups, actions })}</span>
            )}
            {failed > 0 ? (
              <>
                <FailedGlyph />
                <span className="shrink-0">{t("tool.reads.failed", { count: failed })}</span>
              </>
            ) : null}
            {/* Ticking every second: out of the button's accessible name. */}
            {running && clock ? (
              <span aria-hidden className="shrink-0 tabular-nums">
                {clock}
              </span>
            ) : null}
            {!running && calls > 1 ? <SubjectStack subjects={subjects} /> : null}
            <ActivityChevron />
          </CollapsibleTrigger>
        </ActivityLine>
        <CollapsibleContent className={ACTIVITY_CONTENT_CLASS}>
          {/* One step: the header names it, so its content opens straight under the header. */}
          {solo ? steps : <ActivityRail>{steps}</ActivityRail>}
        </CollapsibleContent>
      </Collapsible>
    );

  // The line first, the breakout second: whatever the line becomes, the breakout keeps its place.
  return (
    <div className={ACTIVITY_BLOCK_CLASS}>
      {line}
      <ActivityModeContext value={BREAKOUT_MODE}>{children}</ActivityModeContext>
    </div>
  );
}

/**
 * What the running turn is on, read off the group's last part: the reasoning it writes (its first
 * line once written), the call in progress, or the model thinking after a call's result.
 */
function stepInProgress(
  part: StepPart | undefined,
  stored: StoredResults,
  t: ChatTranslate,
): { label: string; idText?: string } {
  if (part?.type === "reasoning") {
    // Its first line once that line is whole: a label that grows word by word pushes the clock.
    const text = (part.text ?? "").trimStart();
    return { label: (text.includes("\n") && reasoningTitle(text)) || t("reasoning.running") };
  }
  if (part?.type === "tool-call" && isCallInProgress(part)) {
    const presentation = part.toolCallId ? stored.get(part.toolCallId)?.presentation : undefined;
    return showStep(part, presentation, t);
  }
  return { label: t("reasoning.running") };
}
