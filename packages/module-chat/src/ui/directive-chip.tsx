// SPDX-License-Identifier: Apache-2.0

// A skill or agent named in a message as an inline chip: composer, sent bubble, assistant load.

import type { ReactNode } from "react";
import { BookOpenIcon } from "lucide-react";
import { defaultDirectiveFormatter } from "@assistant-ui/core";
import type { DirectiveChipProps } from "@assistant-ui/react-lexical";
import { cn } from "@appstrate/ui/cn";
import { AGENT_DIRECTIVE, SKILL_DIRECTIVE, directiveSegments } from "../directives.ts";
import { DirectiveAgentGlyph } from "./agent-glyph.tsx";

/** A 1em square on the text's baseline: its content is out of flow, so it cannot move it. */
function ChipSlot({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span className={cn("relative inline-block size-[1em] shrink-0 align-[-0.125em]", className)}>
      <span className="absolute inset-0 flex items-center justify-center">{children}</span>
    </span>
  );
}

interface ChipProps {
  directiveType: string;
  directiveId: string;
  label: string;
  className?: string;
}

export function DirectiveChip({ directiveType, directiveId, label, className }: ChipProps) {
  return (
    <span
      data-testid="directive-chip"
      data-directive-type={directiveType}
      // Inline, not flex: it keeps the line's baseline and height, its border on each wrapped piece.
      className={cn(
        "bg-muted text-foreground mx-0.5 rounded-md border box-decoration-clone px-1.5",
        className,
      )}
    >
      <ChipSlot className="mr-1">
        {directiveType === AGENT_DIRECTIVE ? (
          <DirectiveAgentGlyph promptName={directiveId} label={label} className="size-full" />
        ) : (
          <BookOpenIcon className="text-muted-foreground size-full" aria-hidden="true" />
        )}
      </ChipSlot>
      <span>{label}</span>
    </span>
  );
}

/**
 * The composer's chip, deleted with Backspace like a character. The editor turns any `:word[…]`
 * into a directive node — a restored or pasted draft too — so a type that is neither a skill nor an
 * agent is drawn as the text it was, never as a skill's chip (the send and a sent bubble read it as
 * text as well).
 */
export function ComposerDirectiveChip({ directiveType, directiveId, label }: DirectiveChipProps) {
  if (directiveType !== SKILL_DIRECTIVE && directiveType !== AGENT_DIRECTIVE) {
    return (
      <span data-directive-type={directiveType}>
        {defaultDirectiveFormatter.serialize({ type: directiveType, label, id: directiveId })}
      </span>
    );
  }
  return <DirectiveChip directiveType={directiveType} directiveId={directiveId} label={label} />;
}

/** A user message's text, its directives as chips. */
export function DirectiveText({ text }: { text: string }) {
  return (
    <>
      {directiveSegments(text).map((segment, index) =>
        segment.kind === "text" ? (
          <span key={index}>{segment.text}</span>
        ) : (
          <DirectiveChip
            key={index}
            directiveType={segment.type}
            directiveId={segment.id}
            label={segment.label}
          />
        ),
      )}
    </>
  );
}
