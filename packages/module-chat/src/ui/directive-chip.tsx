// SPDX-License-Identifier: Apache-2.0

/**
 * A skill or an agent named in a message, drawn as an inline chip: in the composer (the editor's
 * atomic chip), in the sent bubble (`DirectiveText`, the text part of a user message) and in an
 * assistant message, for a skill the assistant loaded (`skill-load.tsx`).
 */

import { useRef, type MouseEvent, type ReactNode } from "react";
import { BookOpenIcon, XIcon } from "lucide-react";
import type { DirectiveChipProps } from "@assistant-ui/react-lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getNearestNodeFromDOMNode } from "lexical";
import { cn } from "@appstrate/ui/cn";
import { AGENT_DIRECTIVE, directiveSegments } from "../directives.ts";
import { $removeDirectiveChip } from "./directive-chip-remove.ts";
import { DirectiveAgentGlyph } from "./agent-glyph.tsx";
import { useChatHost } from "./runtime-context.ts";

/**
 * A 1em square on the text's baseline, whatever it holds. Its content is absolutely positioned, so
 * the square has no in-flow content and its bottom margin edge is its baseline: the glyph's, the
 * tile's and the X's own font and baselines cannot move it. The flex child centres the content.
 */
function ChipSlot({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span className={cn("relative inline-block size-[1em] shrink-0 align-[-0.125em]", className)}>
      <span className="absolute inset-0 flex items-center justify-center">{children}</span>
    </span>
  );
}

interface ChipProps {
  directiveType: string;
  /** An agent's prompt name: what resolves its tile. */
  directiveId: string;
  label: string;
  /** In the composer only: deletes the chip. */
  remove?: { label: string; onRemove: (chip: HTMLElement) => void };
  /** A state drawn on the chip (an assistant's load still running, or refused). */
  className?: string;
}

export function DirectiveChip({ directiveType, directiveId, label, remove, className }: ChipProps) {
  const ref = useRef<HTMLSpanElement>(null);
  return (
    <span
      ref={ref}
      data-testid="directive-chip"
      data-directive-type={directiveType}
      // An inline box, not a flex one: it takes the text's own font and line-height, so its baseline is
      // the line's and its box (the font's content area, borders paint outside the line box) is
      // centred on the line. A flex chip aligned on its first child's baseline (icon, tile) and
      // grew taller than the line. `box-decoration-clone` keeps the border on each wrapped piece.
      className={cn(
        "group/chip bg-muted text-foreground mx-0.5 rounded-md border box-decoration-clone px-1.5",
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
      {remove && (
        <ChipSlot className="ml-1">
          {/* Not a tab stop: the chip sits in a textbox, where Tab must reach the next control and the
              keyboard already deletes a chip (Backspace on the atomic node). Pointer and touch only. */}
          <button
            type="button"
            tabIndex={-1}
            data-testid="directive-chip-remove"
            aria-label={remove.label}
            // The editor keeps the focus and the caret: the press must not take them.
            onMouseDown={(event: MouseEvent) => event.preventDefault()}
            onClick={() => ref.current && remove.onRemove(ref.current)}
            className="text-muted-foreground hover:bg-foreground/10 hover:text-foreground desktop-pointer:opacity-0 desktop-pointer:group-hover/chip:opacity-100 desktop-pointer:focus-within:opacity-100 relative flex size-full items-center justify-center rounded-full before:absolute before:-inset-2 before:content-['']"
          >
            <XIcon className="size-3" aria-hidden="true" />
          </button>
        </ChipSlot>
      )}
    </span>
  );
}

/** The chip as the composer's editor draws it: the X removes this chip's node. */
export function ComposerDirectiveChip({ directiveType, directiveId, label }: DirectiveChipProps) {
  const [editor] = useLexicalComposerContext();
  const { t } = useChatHost();
  return (
    <DirectiveChip
      directiveType={directiveType}
      directiveId={directiveId}
      label={label}
      remove={{
        label: t("composer.removeDirective", { label }),
        // The decorator gives no node key: the chip's DOM leads to its node.
        onRemove: (chip) =>
          editor.update(() => void $removeDirectiveChip($getNearestNodeFromDOMNode(chip))),
      }}
    />
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
