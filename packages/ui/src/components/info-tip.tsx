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

export function InfoTip({ children, testId }: { children: React.ReactNode; testId?: string }) {
  const { moreInfo } = useUiLabels();
  const [open, setOpen] = React.useState(false);
  // Opened by a click, a tap or a key: the pointer leaving the button no longer closes it.
  const pinned = React.useRef(false);
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
          onPointerEnter={(event) => {
            if (event.pointerType === "mouse") setOpen(true);
          }}
          onPointerLeave={(event) => {
            if (event.pointerType === "mouse" && !pinned.current) setOpen(false);
          }}
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
          // A sentence to read, nothing to operate: the focus stays on the button.
          onOpenAutoFocus={(event) => event.preventDefault()}
          className="bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 z-50 max-w-72 origin-(--radix-popover-content-transform-origin) rounded-md border px-3 py-2 text-sm shadow-md outline-none"
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
