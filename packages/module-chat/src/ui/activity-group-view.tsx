// SPDX-License-Identifier: Apache-2.0

/**
 * Consecutive lookups folded into one line. A turn that looks things up before it
 * answers (search, describe, read, get_me…) otherwise stacks a card per call above
 * the answer; folded, they read « 4 consultations » with the glyphs of what they
 * touched, one click from the cards. Writes are never folded: every call that may
 * change something keeps its own card in the transcript.
 *
 * What counts as a lookup is `isLookupCall` (`activity-group.ts`), the rule the context
 * panel counts by: the engine stamps the call of a tool the platform declares a lookup
 * before it runs (`providerMetadata.appstrate.lookup`, `pi-chat/ui-stream-mapper.ts`), so such
 * a lookup joins its group as it starts; a call whose presentation names a read (`GET`, `HEAD`)
 * joins it when its result lands, and one that fails or is denied leaves it then, its card
 * showing the error among the actions. Reasoning between lookups folds with them: the run of
 * activity before an answer is one group. A group holding fewer than two lookups draws no header
 * and folds nothing, with the same tree, so the second one folds it without remounting the cards.
 *
 * A call the context panel reveals (`reveal-tool-call.ts`) opens its group: a folded group does
 * not mount its cards.
 */

import * as React from "react";
import { useAuiState } from "@assistant-ui/react";
import { ChevronRightIcon, EyeIcon } from "lucide-react";
import type { PresentationSubject, ToolPresentation } from "@appstrate/core/mcp-presentation";
import { Button } from "@appstrate/ui/components/button";
import { Spinner } from "@appstrate/ui/components/spinner";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@appstrate/ui/components/collapsible";
import { useChatHost } from "./runtime-context.ts";
import { SubjectStack } from "./subject-glyph.tsx";
import type { GroupablePart } from "./activity-group.ts";
import { forgetRevealedToolCalls, useRevealedToolCalls } from "./reveal-tool-call.ts";
import { DISCLOSURE_TRIGGER_CLASS } from "./touch-targets.ts";

/** Reads a group needs before it folds. */
const FOLD_AT = 2;

/** The call ids of the tool calls at `indices`, as one string: a stable selection. */
function callIdsAt(parts: readonly GroupablePart[], indices: readonly number[]): string {
  return indices
    .flatMap((i) => {
      const part = parts[i];
      return part?.type === "tool-call" && part.toolCallId ? [part.toolCallId] : [];
    })
    .join("\n");
}

export function ActivityGroup({
  indices,
  presentations,
  children,
}: {
  indices: readonly number[];
  /** The message's call presentations (`useCallPresentations`), by call id. */
  presentations: ReadonlyMap<string, ToolPresentation>;
  children: React.ReactNode;
}) {
  const { t } = useChatHost();
  const joinedIds = useAuiState((s) =>
    callIdsAt(s.message.parts as readonly GroupablePart[], indices),
  );
  const callIds = React.useMemo(() => (joinedIds ? joinedIds.split("\n") : []), [joinedIds]);
  const last = indices[indices.length - 1];
  const running = useAuiState(
    (s) => s.message.status?.type === "running" && s.message.parts.length - 1 === last,
  );
  const subjects = React.useMemo(
    () =>
      callIds.flatMap((id): PresentationSubject[] => {
        const subject = presentations.get(id)?.subject;
        return subject ? [subject] : [];
      }),
    [callIds, presentations],
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
