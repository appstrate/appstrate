// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@appstrate/ui/cn";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@appstrate/ui/components/collapsible";

/** A dashed, collapsed section for what a form rarely needs to touch (« Options », « Avancé »). */
export function AdvancedSection({
  title,
  open,
  onOpenChange,
  triggerTestId,
  contentTestId,
  contentClassName,
  children,
}: {
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerTestId?: string;
  contentTestId?: string;
  contentClassName?: string;
  children: ReactNode;
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="text-foreground hover:bg-muted/50 border-border flex w-full items-center justify-between rounded-md border border-dashed px-3 py-2 text-sm font-medium transition-colors"
          data-testid={triggerTestId}
        >
          <span>{title}</span>
          <ChevronDown
            className={cn(
              "text-muted-foreground size-4 transition-transform",
              open && "rotate-180",
            )}
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className={cn("pt-3", contentClassName)} data-testid={contentTestId}>
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
