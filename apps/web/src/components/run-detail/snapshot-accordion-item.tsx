// SPDX-License-Identifier: Apache-2.0

import type { LucideIcon } from "lucide-react";
import { ChevronDown } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@appstrate/ui/components/collapsible";

export function SnapshotAccordionItem({
  title,
  icon: Icon,
  summary,
  headerRight,
  defaultOpen = false,
  children,
}: {
  title: string;
  icon: LucideIcon;
  summary?: React.ReactNode;
  headerRight?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Collapsible defaultOpen={defaultOpen} className="group border-border border-b">
      <CollapsibleTrigger className="hover:bg-muted/40 focus-visible:ring-ring flex w-full items-center gap-3 px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset">
        <Icon className="text-muted-foreground size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
        {summary && <span className="text-muted-foreground truncate text-xs">{summary}</span>}
        {headerRight}
        <ChevronDown className="text-muted-foreground size-4 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="border-border border-t">
        <div className="px-4 py-3">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}
