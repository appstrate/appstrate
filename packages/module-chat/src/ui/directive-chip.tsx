// SPDX-License-Identifier: Apache-2.0

/**
 * A skill or an agent named in a message, drawn as an inline chip: in the composer (the editor's
 * atomic chip) and in the sent bubble (`DirectiveText`, the text part of a user message).
 */

import { BookOpenIcon, BotIcon } from "lucide-react";
import { AGENT_DIRECTIVE, directiveSegments } from "../directives.ts";

interface DirectiveChipProps {
  directiveType: string;
  label: string;
}

export function DirectiveChip({ directiveType, label }: DirectiveChipProps) {
  const Icon = directiveType === AGENT_DIRECTIVE ? BotIcon : BookOpenIcon;
  return (
    <span
      data-testid="directive-chip"
      data-directive-type={directiveType}
      className="bg-muted text-foreground mx-0.5 inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 align-baseline text-sm leading-snug md:text-xs"
    >
      <Icon className="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{label}</span>
    </span>
  );
}

/** A text of a user message, its directives as chips; the bubble keeps the line breaks. */
export function DirectiveText({ text }: { text: string }) {
  return (
    <>
      {directiveSegments(text).map((segment, index) =>
        segment.kind === "text" ? (
          // Segments only ever append: the position is the identity.
          <span key={index}>{segment.text}</span>
        ) : (
          <DirectiveChip key={index} directiveType={segment.type} label={segment.label} />
        ),
      )}
    </>
  );
}
