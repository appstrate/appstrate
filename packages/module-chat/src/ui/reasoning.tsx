// SPDX-License-Identifier: Apache-2.0

/**
 * The model's reasoning, shown. The engine already streams it
 * (`reasoning-delta`, `pi-chat/ui-stream-mapper.ts`); assistant-ui's default
 * renderer for a reasoning part is `() => null`, and it hides `Empty` (the
 * thinking dots) as soon as the last part is reasoning, so without this the
 * bubble stayed blank for the whole reasoning phase (#1601).
 *
 * One disclosure per run of consecutive reasoning parts (`ReasoningGroup`),
 * open while that run is the part still streaming, so it takes the place the
 * thinking dots held, then folded to one line once the answer moves on. The
 * first click hands the open state to the reader for good.
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

/**
 * Running = message running ∧ this group is its tail, so the group settles once
 * a text or tool part follows, and on a turn stopped or failed mid-reasoning.
 */
export const ReasoningGroup: ReasoningGroupComponent = ({ endIndex, children }) => {
  const { t } = useChatHost();
  const streaming = useAuiState(
    (s) => s.message.status?.type === "running" && s.message.parts.length - 1 === endIndex,
  );
  const [readerOpen, setReaderOpen] = React.useState<boolean | null>(null);
  const open = readerOpen ?? streaming;

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
            <ChevronRightIcon className="duration-fast ease-surface transition-transform group-data-[state=open]:rotate-90" />
          </Button>
        </CollapsibleTrigger>
        {/* A sibling of the trigger, not a child: a button's content is
            presentational, so a live region inside it is not exposed. It keeps
            something moving between the end of the reasoning and the next part. */}
        {streaming ? <ThinkingStatus /> : null}
      </div>
      <CollapsibleContent className="duration-base ease-surface motion-safe:data-[state=open]:animate-collapsible-down motion-safe:data-[state=closed]:animate-collapsible-up overflow-hidden">
        <div className="border-border ml-2 border-l pl-4">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
};
