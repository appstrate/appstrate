// SPDX-License-Identifier: Apache-2.0

/**
 * A tool call on one step line, wherever it is drawn (`CallLine`): the thread names it on a line
 * that opens it in the context panel (`ThreadCallLine`, `tool-uis.tsx`), the panel's Tools tab
 * holds its detail under the same line (`CallStep`). Presentational: everything comes by props, so
 * it reads no chat host and no assistant-ui state. The line holds the lead, the line's control
 * (label, id), what follows it, and the failure's cross; the failure's message stays under it,
 * muted.
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

/** What a call's line says besides its control. */
interface CallLineFacts {
  lead: React.ReactNode;
  /** What follows the control (a count, a space, a duration), each `shrink-0`; absent when none. */
  trailing?: React.ReactNode;
  /** The call failed: a cross, an image named by `label`, ends the line. */
  failure?: { label: string } | undefined;
  /** What the failure says, under the line. */
  errorText?: string | undefined;
}

/** A call's name in its line's control: its label, shimmering while it runs, then its target. */
export function CallName({
  label,
  idText,
  running = false,
}: {
  label: React.ReactNode;
  idText?: string | undefined;
  running?: boolean;
}) {
  return (
    <>
      <ActivityLabel active={running}>{label}</ActivityLabel>
      {idText ? <ActivityId>{idText}</ActivityId> : null}
    </>
  );
}

/**
 * The line, around its control. What lands with the result (duration, cross) follows the control
 * on a line of fixed height: its arrival moves nothing.
 */
export function CallLine({
  control,
  lead,
  trailing,
  failure,
  errorText,
}: CallLineFacts & { control: React.ReactNode }) {
  return (
    <>
      <ActivityLine lead={lead}>
        {control}
        {trailing}
        {failure ? <FailedGlyph label={failure.label} /> : null}
      </ActivityLine>
      {errorText ? (
        <p className="text-muted-foreground pb-1.5 pl-6 text-xs break-words">{errorText}</p>
      ) : null}
    </>
  );
}

type CallStepProps = Omit<React.HTMLAttributes<HTMLDivElement>, "children"> &
  CallLineFacts &
  React.ComponentProps<typeof CallName> & {
    ref?: React.Ref<HTMLDivElement>;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** The call's detail, drawn in a card under the line once it opens. */
    children: React.ReactNode;
  };

/** The panel's call: its line a disclosure, its detail in a card under it. */
export function CallStep({
  lead,
  label,
  idText,
  running,
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
      <CallLine
        lead={lead}
        trailing={trailing}
        failure={failure}
        errorText={errorText}
        control={
          <CollapsibleTrigger render={<ActivityTrigger />}>
            <CallName label={label} idText={idText} running={running} />
            <ActivityChevron />
          </CollapsibleTrigger>
        }
      />
      <CollapsibleContent className={ACTIVITY_CONTENT_CLASS}>
        <div className={ACTIVITY_DETAIL_CLASS}>
          <div className="bg-card rounded-lg border p-3">{children}</div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
