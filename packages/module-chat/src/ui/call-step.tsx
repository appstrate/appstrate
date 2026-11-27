// SPDX-License-Identifier: Apache-2.0

/**
 * A tool call on one step line, wherever it is drawn: in the thread's activity group (`ToolStep`)
 * and in the context panel's Tools tab. Presentational: everything comes by props, so it reads no
 * chat host and no assistant-ui state. The line holds the lead, the trigger (label, id, chevron),
 * what follows it, and the failure's cross; the failure's message stays under it, muted; the
 * detail opens under it in a card.
 *
 * `bare`: the call is its group's one step, whose header already names it. No line of its own:
 * what follows the label (a count, a space, a duration, the cross) on one muted line, then the
 * failure's message and the detail, aligned under the header's label.
 */

import * as React from "react";
import { cn } from "@appstrate/ui/cn";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@appstrate/ui/components/collapsible";
import {
  ACTIVITY_CONTENT_CLASS,
  ACTIVITY_DETAIL_CLASS,
  ActivityChevron,
  ActivityId,
  ActivityLabel,
  ActivityLine,
  ActivityTrigger,
  FailedGlyph,
} from "./activity-line.tsx";

export type CallStepProps = Omit<
  React.ComponentProps<typeof Collapsible>,
  "open" | "onOpenChange" | "children"
> & {
  lead: React.ReactNode;
  label: React.ReactNode;
  idText?: string | undefined;
  /** The call runs: its label shimmers. */
  running?: boolean;
  /** What follows the label (a count, a space, a duration), each `shrink-0`; absent when none. */
  trailing?: React.ReactNode;
  /** The call failed: a cross, an image named by `label`, ends what follows the label. */
  failure?: { label: string } | undefined;
  /** What the failure says, under the line. */
  errorText?: string | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The group's one step, drawn without its line (see the file's header). */
  bare?: boolean;
  /** The call's detail, drawn in a card under the line once it opens. */
  children: React.ReactNode;
};

const ERROR_CLASS = "text-muted-foreground pb-1.5 text-xs break-words";
const DETAIL_CARD_CLASS = "bg-card rounded-lg border p-3";

export function CallStep({
  lead,
  label,
  idText,
  running = false,
  trailing,
  failure,
  errorText,
  open,
  onOpenChange,
  bare = false,
  children,
  ...root
}: CallStepProps) {
  const cross = failure ? <FailedGlyph label={failure.label} /> : null;
  if (bare) {
    return (
      <div {...root} className={cn(ACTIVITY_DETAIL_CLASS, root.className)}>
        {trailing || cross ? (
          <div className="text-muted-foreground flex min-w-0 items-center gap-2 pb-2 text-sm">
            {trailing}
            {cross}
          </div>
        ) : null}
        {errorText ? <p className={ERROR_CLASS}>{errorText}</p> : null}
        <div className={DETAIL_CARD_CLASS}>{children}</div>
      </div>
    );
  }
  return (
    <Collapsible {...root} open={open} onOpenChange={onOpenChange}>
      {/* What lands with the result (duration, cross) follows the trigger on a line of fixed
          height: its arrival moves nothing. */}
      <ActivityLine lead={lead}>
        <CollapsibleTrigger asChild>
          <ActivityTrigger>
            <ActivityLabel active={running}>{label}</ActivityLabel>
            {idText ? <ActivityId>{idText}</ActivityId> : null}
            <ActivityChevron />
          </ActivityTrigger>
        </CollapsibleTrigger>
        {trailing}
        {cross}
      </ActivityLine>
      {errorText ? <p className={cn(ERROR_CLASS, "pl-6")}>{errorText}</p> : null}
      <CollapsibleContent className={ACTIVITY_CONTENT_CLASS}>
        <div className={ACTIVITY_DETAIL_CLASS}>
          <div className={DETAIL_CARD_CLASS}>{children}</div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
