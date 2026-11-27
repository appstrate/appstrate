// SPDX-License-Identifier: Apache-2.0

/**
 * A tool call on one step line, wherever it is drawn: in the thread's activity group (`ToolStep`)
 * and in the context panel's Tools tab. Presentational: everything comes by props, so it reads no
 * chat host and no assistant-ui state. The line holds the lead, the trigger (label, id, chevron),
 * what follows it, and the failure's cross; the failure's message stays under it, muted; the
 * detail opens under it in a card.
 */

import * as React from "react";
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
  /** What follows the trigger on the line (a count, a space, a duration), each `shrink-0`. */
  trailing?: React.ReactNode;
  /**
   * The call failed: a cross ends the line. `visible` writes `label` beside it, muted; otherwise
   * the cross is an image named by it.
   */
  failure?: { label: string; visible?: boolean } | undefined;
  /** What the failure says, under the line. */
  errorText?: string | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The call's detail, drawn in a card under the line once it opens. */
  children: React.ReactNode;
};

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
  children,
  ...root
}: CallStepProps) {
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
        {failure ? (
          failure.visible ? (
            <span className="flex shrink-0 items-center gap-1 text-xs">
              <FailedGlyph />
              {failure.label}
            </span>
          ) : (
            <FailedGlyph label={failure.label} />
          )
        ) : null}
      </ActivityLine>
      {errorText ? (
        <p className="text-muted-foreground pb-1.5 pl-6 text-xs break-words">{errorText}</p>
      ) : null}
      <CollapsibleContent className={ACTIVITY_CONTENT_CLASS}>
        <div className={ACTIVITY_DETAIL_CLASS}>
          <div className="bg-card rounded-lg border p-3">{children}</div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
