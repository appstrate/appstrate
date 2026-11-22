// SPDX-License-Identifier: Apache-2.0

// A skill or agent named in a message as an inline chip: composer, sent bubble, assistant load.

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
  /** In the composer only: deletes the chip. */
  remove?: { label: string; onRemove: (chip: HTMLElement) => void };
  className?: string;
}

export function DirectiveChip({ directiveType, directiveId, label, remove, className }: ChipProps) {
  const ref = useRef<HTMLSpanElement>(null);
  return (
    <span
      ref={ref}
      data-testid="directive-chip"
      data-directive-type={directiveType}
      // Inline, not flex: it keeps the line's baseline and height, its border on each wrapped piece.
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
          {/* Not a tab stop: in a textbox, Backspace already deletes the chip. */}
          <button
            type="button"
            tabIndex={-1}
            data-testid="directive-chip-remove"
            aria-label={remove.label}
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

/** The composer's chip: the X removes its node, found through its DOM (no node key is given). */
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
        onRemove: (chip) =>
          editor.update(() => void $removeDirectiveChip($getNearestNodeFromDOMNode(chip))),
      }}
    />
  );
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
