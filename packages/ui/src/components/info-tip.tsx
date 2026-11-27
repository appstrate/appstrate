// SPDX-License-Identifier: Apache-2.0

/**
 * A short explanation behind an ⓘ button (a toggletip). A mouse shows it on hover; a click, a tap
 * or a key press opens it and keeps it open until the next one, a press outside or Escape. A
 * tooltip alone would leave a phone without it: a touch never hovers.
 *
 * A bubble on every screen, in a portal so a scrolling panel does not clip it: its text is a
 * sentence, not a menu, so it is not the `Popover` wrapper, which becomes a sheet on a phone. It is
 * mounted only while open: a caller that needs the text read with a control points the control's
 * `aria-describedby` at a copy of its own.
 */

import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { InfoIcon } from "lucide-react";

import { useUiLabels } from "./ui-labels.ts";

/** How long the bubble outlasts the pointer leaving the button, for the pointer to reach it. */
const HOVER_CLOSE_MS = 150;

export function InfoTip({ children, testId }: { children: React.ReactNode; testId?: string }) {
  const { moreInfo } = useUiLabels();
  const [open, setOpen] = React.useState(false);
  // Opened by a click, a tap or a key: the pointer leaving no longer closes it.
  const pinned = React.useRef(false);
  // Leaving the button or the bubble waits a beat, so the pointer can cross from one to the other
  // and the bubble can be hovered (WCAG 1.4.13).
  const closing = React.useRef<ReturnType<typeof setTimeout>>(undefined);
  const hover = (event: React.PointerEvent) => {
    if (event.pointerType !== "mouse") return;
    clearTimeout(closing.current);
    setOpen(true);
  };
  const unhover = (event: React.PointerEvent) => {
    if (event.pointerType !== "mouse" || pinned.current) return;
    clearTimeout(closing.current);
    closing.current = setTimeout(() => setOpen(false), HOVER_CLOSE_MS);
  };
  React.useEffect(() => () => clearTimeout(closing.current), []);
  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) pinned.current = false;
        setOpen(next);
      }}
    >
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          aria-label={moreInfo}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 desktop-pointer:size-5 inline-flex size-7 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-[3px]"
          data-testid={testId}
          onPointerEnter={hover}
          onPointerLeave={unhover}
          onClick={(event) => {
            // Radix would toggle: a click on what a hover opened pins it instead of closing it.
            // Inside a `<label>`, it also keeps the click from reaching the labelled control.
            event.preventDefault();
            pinned.current = !(open && pinned.current);
            setOpen(pinned.current);
          }}
        >
          {/* Important: a menu row sizes every icon inside it, this one included, for a row's glyph. */}
          <InfoIcon aria-hidden className="desktop-pointer:size-3.5! size-4!" />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="top"
          sideOffset={6}
          collisionPadding={8}
          // A sentence to read, nothing to operate: a tooltip, not a dialog, and the focus stays
          // on the button.
          role="tooltip"
          onPointerEnter={hover}
          onPointerLeave={unhover}
          onOpenAutoFocus={(event) => event.preventDefault()}
          className="bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 z-50 max-w-72 origin-(--radix-popover-content-transform-origin) rounded-md border px-3 py-2 text-sm shadow-md outline-none"
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
