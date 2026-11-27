// SPDX-License-Identifier: Apache-2.0

/**
 * A composer setting that departs from the default, shown as a chip whose X restores the default.
 * With `open`, the chip's body is itself a button (it reopens the setting's picker). Inside a
 * chip row (`data-chip-row`), the X hands the focus on to its neighbour as the chip leaves.
 */

import type { ComponentProps, ReactNode } from "react";
import { XIcon } from "lucide-react";
import { badgeVariants } from "@appstrate/ui/components/badge";
import { NOTE_TEXT_CLASS } from "./phone-text.ts";
import { cn } from "@appstrate/ui/cn";
import { handOverFocusOnRemoval } from "./chip-focus.ts";
import { CHIP_REMOVE_CLASS } from "./touch-targets.ts";

const ICON = "[&>svg]:size-3.5 [&>svg]:shrink-0";

interface RemovableChipProps extends Omit<ComponentProps<"span">, "children"> {
  icon: ReactNode;
  children: ReactNode;
  removeLabel: string;
  removeDisabled?: boolean;
  /** Absent: nothing to restore, the chip has no X. */
  onRemove?: () => void;
  open?: { onClick: () => void; label: string; testId: string };
}

export function RemovableChip({
  icon,
  children,
  removeLabel,
  removeDisabled = false,
  onRemove,
  open,
  className,
  ...rest
}: RemovableChipProps) {
  const body = (
    <>
      {icon}
      <span className="block min-w-0 truncate">{children}</span>
    </>
  );
  return (
    // `rest` carries what a trigger rendering it (`render`) passes: ref, handlers, state attributes.
    <span
      {...rest}
      data-removable-chip=""
      className={cn(
        badgeVariants({ variant: "secondary" }),
        "text-muted-foreground desktop-pointer:h-7 h-10 max-w-56 min-w-0 shrink gap-1.5 py-0 pl-2.5 font-normal",
        onRemove ? "desktop-pointer:pr-1 pr-0" : "pr-2.5",
        NOTE_TEXT_CLASS,
        ICON,
        className,
      )}
    >
      {open ? (
        <button
          type="button"
          aria-label={open.label}
          data-testid={open.testId}
          onClick={open.onClick}
          // The base layer sets every button to `text-sm font-medium`: the body keeps the chip's type.
          className={cn("flex h-full min-w-0 items-center gap-1.5 [font:inherit]", ICON)}
        >
          {body}
        </button>
      ) : (
        body
      )}
      {onRemove && (
        <button
          type="button"
          aria-label={removeLabel}
          disabled={removeDisabled}
          onClick={(event) => {
            handOverFocusOnRemoval(event.currentTarget);
            onRemove();
          }}
          className={cn(
            "hover:bg-foreground/10 desktop-pointer:size-5 rounded-full disabled:pointer-events-none disabled:opacity-50",
            CHIP_REMOVE_CLASS,
          )}
        >
          <XIcon className="size-3" />
        </button>
      )}
    </span>
  );
}
