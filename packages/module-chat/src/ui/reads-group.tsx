// SPDX-License-Identifier: Apache-2.0

/**
 * Consecutive reads folded into one line. A turn that looks things up before it
 * answers (search, describe, read, get_me…) otherwise stacks a card per call above
 * the answer; folded, they read « 4 consultations » with the glyphs of what they
 * touched, one click from the cards. Writes are never folded: every call that may
 * change something keeps its own card in the transcript, and so does a read that
 * failed (errors stay inline).
 *
 * What counts as a read is decided before the call runs: the engine stamps the call
 * of a tool the platform declares a lookup (`isLookupTool`, `@appstrate/core/mcp-presentation`)
 * with `providerMetadata.appstrate.lookup` (`pi-chat/ui-stream-mapper.ts`), so a successful
 * read joins its group as it starts; only a failure leaves it, when its error lands. Reasoning
 * between reads folds with them: the run of activity before an answer is one group. A group holding fewer than two reads draws no header and folds
 * nothing, with the same tree, so the second read folds it without remounting the cards.
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
import { presentationOf } from "./tool-presentation.ts";
import { SubjectStack } from "./subject-glyph.tsx";

/** Reads a group needs before it folds. */
const FOLD_AT = 2;

interface ToolCallLike {
  readonly type: string;
  readonly result?: unknown;
}

export function ActivityGroup({
  indices,
  children,
}: {
  indices: readonly number[];
  children: React.ReactNode;
}) {
  const { t } = useChatHost();
  const parts = useAuiState((s) => s.message.parts) as readonly ToolCallLike[];
  const last = indices[indices.length - 1];
  const running = useAuiState(
    (s) => s.message.status?.type === "running" && s.message.parts.length - 1 === last,
  );
  const { reads, subjects } = React.useMemo(() => {
    const calls = indices.map((i) => parts[i]).filter((p) => p?.type === "tool-call");
    const found: PresentationSubject[] = [];
    for (const call of calls) {
      const subject = presentationOf(call?.result)?.subject;
      if (subject) found.push(subject);
    }
    return { reads: calls.length, subjects: found };
  }, [indices, parts]);
  const [readerOpen, setReaderOpen] = React.useState(false);
  const folded = reads >= FOLD_AT;

  return (
    <Collapsible open={folded ? readerOpen : true} onOpenChange={setReaderOpen}>
      {folded ? (
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground group my-1 -ml-2 gap-1.5 px-2"
          >
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
