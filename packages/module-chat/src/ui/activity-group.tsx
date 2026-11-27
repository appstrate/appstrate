// SPDX-License-Identifier: Apache-2.0

/**
 * Consecutive lookups folded into one line (« 4 consultations », the glyphs of what they touched),
 * one click from their cards; a call that may change something keeps its own card.
 *
 * A call joins on the engine's pre-call stamp alone (`activityGroupOf`), so no card moves when its
 * result lands: a failed lookup stays in its group, shown failed on its own row and counted in the
 * header. Reasoning between lookups folds with them. A group holding fewer than {@link FOLD_AT}
 * lookups draws no header, with the same tree, so the next one folds it without remounting cards.
 * A call the context panel reveals (`reveal-tool-call.ts`) opens its group: a folded one does not
 * mount its cards.
 *
 * Folded and ending the running message, its header reads like a coding agent's status line: the
 * spark (the turn's status region, beside the trigger), the step in progress, the lookup count, the
 * failed count, the turn's clock. Settled: an eye where the spark was, the count, the failed count,
 * what the lookups touched.
 */

import * as React from "react";
import { useAuiState } from "@assistant-ui/react";
import { ChevronRightIcon, EyeIcon } from "lucide-react";
import type { PresentationSubject } from "@appstrate/core/mcp-presentation";
import { Button } from "@appstrate/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@appstrate/ui/components/collapsible";
import { useChatHost } from "./runtime-context.ts";
import { SubjectStack } from "./subject-glyph.tsx";
import { FOLD_AT, lookupsAt, type GroupablePart } from "./conversation-tools.ts";
import { FailedGlyph } from "./tool-uis.tsx";
import { ThinkingStatus } from "./reasoning.tsx";
import { useTurnClock } from "./use-turn-clock.ts";
import { showStep } from "./turn-status.ts";
import { deriveToolPhase } from "./tool-result.ts";
import type { StoredResults } from "./use-call-presentation.ts";
import { presentationSubject } from "./tool-presentation.ts";
import { forgetRevealedToolCalls, useRevealedToolCalls } from "./reveal-tool-call.ts";
import { DISCLOSURE_TRIGGER_CLASS } from "./touch-targets.ts";

/** A thread part as the header reads it: a call's name and arguments for {@link showStep}. */
type StepPart = GroupablePart & { readonly toolName?: string; readonly args?: unknown };

/** The message as {@link ActivityGroup}'s step selectors read it. */
interface StepMessage {
  readonly status?: { readonly type: string };
  readonly parts: readonly unknown[];
}

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
  // Strings, not arrays: a selector returning a fresh value would re-render forever.
  const joinedIds = useAuiState((s) =>
    lookupsAt(s.message.parts as readonly GroupablePart[], indices)
      .map((part) => part.toolCallId)
      .join("\n"),
  );
  const failed = useAuiState(
    (s) =>
      lookupsAt(s.message.parts as readonly GroupablePart[], indices).filter(
        (part) => deriveToolPhase(part) === "error",
      ).length,
  );
  const lastIndex = indices[indices.length - 1];
  // The step in progress while this group ends the running message.
  const stepOf = (message: StepMessage) => {
    if (message.status?.type !== "running" || message.parts.length - 1 !== lastIndex) return;
    const part = message.parts[lastIndex] as StepPart | undefined;
    if (!part) return;
    const presentation = part.toolCallId ? stored.get(part.toolCallId)?.presentation : undefined;
    return showStep(part, presentation, t);
  };
  const stepLabel = useAuiState((s) => stepOf(s.message)?.label ?? "");
  const stepIdText = useAuiState((s) => stepOf(s.message)?.idText ?? "");
  const callIds = React.useMemo(() => (joinedIds ? joinedIds.split("\n") : []), [joinedIds]);
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
  const reads = callIds.length;
  const [readerOpen, setReaderOpen] = React.useState(false);
  const folded = reads >= FOLD_AT;
  const running = folded && stepLabel !== "";
  const clock = useTurnClock(running);
  const onOpenChange = (open: boolean) => {
    setReaderOpen(open);
    if (!open) forgetRevealedToolCalls(callIds);
  };

  return (
    <Collapsible open={folded ? readerOpen || revealed : true} onOpenChange={onOpenChange}>
      {folded ? (
        <div className="my-1 flex min-w-0 items-center gap-2">
          {/* One leading slot in both states, so the trigger does not shift when the turn ends.
              The spark is a sibling of the trigger: a live region inside a button is not exposed. */}
          <span className="text-muted-foreground flex h-6 w-4 shrink-0 items-center justify-center">
            {running ? <ThinkingStatus /> : <EyeIcon aria-hidden className="size-4" />}
          </span>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className={`min-w-0 ${DISCLOSURE_TRIGGER_CLASS}`}>
              {running ? (
                <>
                  <span className="text-foreground min-w-0 truncate">{stepLabel}</span>
                  {stepIdText ? <span className="min-w-0 truncate">{stepIdText}</span> : null}
                </>
              ) : null}
              <span className="shrink-0">{t("tool.reads.done", { count: reads })}</span>
              {failed > 0 ? (
                <>
                  <FailedGlyph />
                  <span className="shrink-0">{t("tool.reads.failed", { count: failed })}</span>
                </>
              ) : null}
              {running && clock ? <span className="shrink-0 tabular-nums">{clock}</span> : null}
              {running ? null : <SubjectStack subjects={subjects} />}
              <ChevronRightIcon className="duration-fast ease-surface transition-transform group-data-[state=open]:rotate-90" />
            </Button>
          </CollapsibleTrigger>
        </div>
      ) : null}
      <CollapsibleContent
        className={
          folded
            ? "duration-base ease-surface motion-safe:data-[state=open]:animate-collapsible-down motion-safe:data-[state=closed]:animate-collapsible-up overflow-hidden"
            : undefined
        }
      >
        <div className={folded ? "border-border ml-2 border-l pl-4" : undefined}>{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}
