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
 */

import * as React from "react";
import { useAuiState } from "@assistant-ui/react";
import { ChevronRightIcon, EyeIcon } from "lucide-react";
import type { PresentationSubject } from "@appstrate/core/mcp-presentation";
import { Button } from "@appstrate/ui/components/button";
import { Spinner } from "@appstrate/ui/components/spinner";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@appstrate/ui/components/collapsible";
import { useChatHost } from "./runtime-context.ts";
import { SubjectStack } from "./subject-glyph.tsx";
import type { GroupablePart } from "./conversation-tools.ts";
import { deriveToolPhase } from "./tool-result.ts";
import type { StoredResults } from "./use-call-presentation.ts";
import { forgetRevealedToolCalls, useRevealedToolCalls } from "./reveal-tool-call.ts";
import { DISCLOSURE_TRIGGER_CLASS } from "./touch-targets.ts";

const FOLD_AT = 2;

function callsAt(parts: readonly GroupablePart[], indices: readonly number[]): GroupablePart[] {
  return indices.flatMap((i) => {
    const part = parts[i];
    return part?.type === "tool-call" && part.toolCallId ? [part] : [];
  });
}

export function ActivityGroup({
  indices,
  running,
  stored,
  children,
}: {
  indices: readonly number[];
  running: boolean;
  stored: StoredResults;
  children: React.ReactNode;
}) {
  const { t } = useChatHost();
  // Strings, not arrays: a selector returning a fresh value would re-render forever.
  const joinedIds = useAuiState((s) =>
    callsAt(s.message.parts as readonly GroupablePart[], indices)
      .map((part) => part.toolCallId)
      .join("\n"),
  );
  const failed = useAuiState(
    (s) =>
      callsAt(s.message.parts as readonly GroupablePart[], indices).filter(
        (part) => deriveToolPhase(part) === "error",
      ).length,
  );
  const callIds = React.useMemo(() => (joinedIds ? joinedIds.split("\n") : []), [joinedIds]);
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
  const reads = callIds.length;
  const [readerOpen, setReaderOpen] = React.useState(false);
  const folded = reads >= FOLD_AT;
  const onOpenChange = (open: boolean) => {
    setReaderOpen(open);
    if (!open) forgetRevealedToolCalls(callIds);
  };

  return (
    <Collapsible open={folded ? readerOpen || revealed : true} onOpenChange={onOpenChange}>
      {folded ? (
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className={`my-1 ${DISCLOSURE_TRIGGER_CLASS}`}>
            {running ? <Spinner className="size-4" /> : <EyeIcon />}
            {running ? t("tool.reads.running") : t("tool.reads.done", { count: reads })}
            {failed > 0 ? (
              <span className="text-destructive">{t("tool.reads.failed", { count: failed })}</span>
            ) : null}
            <SubjectStack subjects={subjects} />
            <ChevronRightIcon className="duration-fast ease-surface transition-transform group-data-[state=open]:rotate-90" />
          </Button>
        </CollapsibleTrigger>
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
