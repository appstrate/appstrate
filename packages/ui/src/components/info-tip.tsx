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

import type * as React from "react";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { InfoIcon } from "lucide-react";

import { useUiLabels } from "./ui-labels.ts";

export function InfoTip({ children, testId }: { children: React.ReactNode; testId?: string }) {
  const { moreInfo } = useUiLabels();
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger
        aria-label={moreInfo}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 desktop-pointer:size-5 inline-flex size-7 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-[3px]"
        data-testid={testId}
        // A mouse hover opens it; a click on what a hover opened pins it open.
        openOnHover
        delay={0}
        closeDelay={0}
        // Inside a `<label>`, the click must not reach the labelled control.
        onClick={(event) => event.preventDefault()}
      >
        {/* Important: a menu row sizes every icon inside it, this one included, for a row's glyph. */}
        <InfoIcon aria-hidden className="desktop-pointer:size-3.5! size-4!" />
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner
          side="top"
          sideOffset={6}
          collisionPadding={8}
          className="z-50"
        >
          <PopoverPrimitive.Popup
            // A sentence to read, nothing to operate: a tooltip, not a dialog, and the focus stays
            // on the button.
            role="tooltip"
            initialFocus={false}
            className="bg-popover text-popover-foreground data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 max-w-72 origin-(--transform-origin) rounded-md border px-3 py-2 text-sm shadow-md outline-none"
          >
            {children}
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
