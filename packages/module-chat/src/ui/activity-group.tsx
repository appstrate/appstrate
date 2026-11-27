// SPDX-License-Identifier: Apache-2.0

/**
 * What the assistant did between two texts, on one line: its reasoning and its tool calls, one
 * step or twenty. The line is the same from the first step on, so nothing changes shape when a
 * second one joins (`activityGroupOf`). Opened, it is a rail of steps, each one click from its
 * own detail. A call the context panel reveals (`reveal-tool-call.ts`) opens its group: a folded
 * one does not mount its steps.
 *
 * Ending the running message, the line is the turn's status: the spark (the status region, beside
 * the trigger), the step in progress, the turn's clock. Settled, it names its one call, or counts
 * them (« 3 consultations · 1 action »), failures apart; a group of reasoning alone reads its
 * first line.
 *
 * `children` is drawn twice: as steps under the rail, and as what must stay in view whatever the
 * fold (`activity-mode.ts`, "breakout": a connect card, a launched run, a created package's link).
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
import { callsAt, isStampedLookup, type GroupablePart } from "./conversation-tools.ts";
import { FailedGlyph } from "./tool-uis.tsx";
import { ThinkingStatus } from "./reasoning.tsx";
import { useTurnClock } from "./use-turn-clock.ts";
import { reasoningTitle, showStep } from "./turn-status.ts";
import { showCall } from "./tool-presentation.ts";
import { deriveToolPhase } from "./tool-result.ts";
import type { StoredResults } from "./use-call-presentation.ts";
import { forgetRevealedToolCalls, useRevealedToolCalls } from "./reveal-tool-call.ts";
import {
  ACTIVITY_BLOCK_CLASS,
  ACTIVITY_CONTENT_CLASS,
  ActivityChevron,
  ActivityId,
  ActivityLabel,
  ActivityLine,
  ActivityRail,
  ActivityTrigger,
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

/** The reasoning runs among `parts` at `indices`: each is one step under the rail. */
function reasoningRunsAt(parts: readonly GroupablePart[], indices: readonly number[]): number {
  let runs = 0;
  let inRun = false;
  for (const i of indices) {
    const reasoning = parts[i]?.type === "reasoning";
    if (reasoning && !inRun) runs += 1;
    inRun = reasoning;
  }
  return runs;
}

/** The first line of the group's reasoning, its title when it holds no call. */
function reasoningTitleAt(parts: readonly StepPart[], indices: readonly number[]): string {
  for (const i of indices) {
    const part = parts[i];
    const title = part?.type === "reasoning" ? reasoningTitle(part.text ?? "") : "";
    if (title) return title;
  }
  return "";
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
  const lastIndex = indices[indices.length - 1];
  // Strings and numbers, not arrays: a selector returning a fresh value would re-render forever.
  const joinedIds = useAuiState((s) =>
    callsAt(s.message.parts as readonly GroupablePart[], indices)
      .map((part) => part.toolCallId)
      .join("\n"),
  );
  const lookups = useAuiState(
    (s) =>
      callsAt(s.message.parts as readonly GroupablePart[], indices).filter(isStampedLookup).length,
  );
  const failed = useAuiState(
    (s) =>
      callsAt(s.message.parts as readonly GroupablePart[], indices).filter(
        (part) => deriveToolPhase(part) === "error",
      ).length,
  );
  const reasoningRuns = useAuiState((s) =>
    reasoningRunsAt(s.message.parts as readonly GroupablePart[], indices),
  );
  const running = useAuiState(
    (s) => s.message.status?.type === "running" && s.message.parts.length - 1 === lastIndex,
  );
  // The step in progress while this group ends the running message.
  const stepOf = (message: StepMessage) => stepInProgress(message, lastIndex, stored, t);
  const stepLabel = useAuiState((s) => (running ? stepOf(s.message).label : ""));
  const stepIdText = useAuiState((s) => (running ? (stepOf(s.message).idText ?? "") : ""));
  const callIds = React.useMemo(() => (joinedIds ? joinedIds.split("\n") : []), [joinedIds]);
  const calls = callIds.length;
  // The group's one call, as the thread holds it: an existing object, so a stable selection.
  const onlyCall = useAuiState((s) =>
    calls === 1
      ? (callsAt(s.message.parts as readonly StepPart[], indices)[0] ?? undefined)
      : undefined,
  );
  const title = useAuiState((s) =>
    calls === 0 && !running
      ? reasoningTitleAt(s.message.parts as readonly StepPart[], indices)
      : "",
  );
  const subjects = React.useMemo(
    () =>
      callIds.flatMap((id): PresentationSubject[] => {
        const subject = stored.get(id)?.presentation?.subject;
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
  const counts = [
    lookups > 0 ? t("tool.reads.done", { count: lookups }) : null,
    actions > 0 ? t("tool.actions.done", { count: actions }) : null,
  ].filter((part): part is string => part !== null);

  const lead = running ? (
    <ThinkingStatus />
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

  return (
    <Collapsible
      open={readerOpen || revealed}
      onOpenChange={onOpenChange}
      className={ACTIVITY_BLOCK_CLASS}
    >
      {/* The spark is a sibling of the trigger: a live region inside a button is not exposed. */}
      <ActivityLine lead={lead}>
        <CollapsibleTrigger asChild>
          <ActivityTrigger>
            {running ? (
              <>
                <ActivityLabel active>{stepLabel}</ActivityLabel>
                {stepIdText ? <ActivityId>{stepIdText}</ActivityId> : null}
              </>
            ) : only ? (
              <>
                <ActivityLabel>{only.label}</ActivityLabel>
                {only.idText ? <ActivityId>{only.idText}</ActivityId> : null}
              </>
            ) : calls === 0 ? (
              <ActivityLabel>{title || t("reasoning.done")}</ActivityLabel>
            ) : (
              <span className="shrink-0">{counts.join(" · ")}</span>
            )}
            {failed > 0 ? (
              <>
                <FailedGlyph />
                <span className="shrink-0">{t("tool.reads.failed", { count: failed })}</span>
              </>
            ) : null}
            {running && clock ? <span className="shrink-0 tabular-nums">{clock}</span> : null}
            {!running && calls > 1 ? <SubjectStack subjects={subjects} /> : null}
            <ActivityChevron />
          </ActivityTrigger>
        </CollapsibleTrigger>
      </ActivityLine>
      <CollapsibleContent className={ACTIVITY_CONTENT_CLASS}>
        <ActivityRail>
          <ActivityModeContext value={stepMode}>{children}</ActivityModeContext>
        </ActivityRail>
      </CollapsibleContent>
      <ActivityModeContext value={BREAKOUT_MODE}>{children}</ActivityModeContext>
    </Collapsible>
  );
}

/**
 * What the running turn is on, read off the group's last part: the reasoning it writes (its first
 * line once written), the call that runs, or the model thinking after a call's result.
 */
function stepInProgress(
  message: StepMessage,
  lastIndex: number | undefined,
  stored: StoredResults,
  t: ChatTranslate,
): { label: string; idText?: string } {
  const part = lastIndex === undefined ? undefined : (message.parts[lastIndex] as StepPart);
  if (part?.type === "reasoning") {
    // Its first line once that line is whole: a label that grows word by word pushes the clock.
    const text = (part.text ?? "").trimStart();
    return { label: (text.includes("\n") && reasoningTitle(text)) || t("reasoning.running") };
  }
  const phase = part?.type === "tool-call" ? deriveToolPhase(part) : undefined;
  if (part && (phase === "running" || phase === "pending")) {
    const presentation = part.toolCallId ? stored.get(part.toolCallId)?.presentation : undefined;
    return showStep(part, presentation, t);
  }
  return { label: t("reasoning.running") };
}
