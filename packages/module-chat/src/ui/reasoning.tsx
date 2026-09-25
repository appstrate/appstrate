// SPDX-License-Identifier: Apache-2.0

/**
 * The model's reasoning, shown. The engine already streams it
 * (`reasoning-delta`, `pi-chat/ui-stream-mapper.ts`); assistant-ui's default
 * renderer for a reasoning part is `() => null`, so until now it was sent and
 * dropped on screen.
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
export const ReasoningGroup: ReasoningGroupComponent = ({ endIndex, children }) => {
  const streaming = useAuiState(
    (s) => s.message.status?.type === "running" && s.message.parts.length - 1 === endIndex,
  );
  const [readerOpen, setReaderOpen] = React.useState<boolean | null>(null);
  const open = readerOpen ?? streaming;

  return (
    <Collapsible open={open} onOpenChange={setReaderOpen} className="my-2">
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:text-foreground group -ml-2 gap-1.5 px-2"
        >
          <BrainIcon />
          {streaming ? "Réflexion en cours…" : "Réflexion"}
          <ChevronRightIcon className="duration-fast ease-surface transition-transform group-data-[state=open]:rotate-90" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="duration-base ease-surface motion-safe:data-[state=open]:animate-collapsible-down motion-safe:data-[state=closed]:animate-collapsible-up overflow-hidden">
        <div className="border-border ml-2 border-l pl-4">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
};
