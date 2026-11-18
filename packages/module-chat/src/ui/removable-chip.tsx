// SPDX-License-Identifier: Apache-2.0

/**
 * A composer setting that departs from the default, shown as a chip whose X restores the default.
 * With `open`, the chip's body is itself a button (it reopens the setting's picker).
 */

import type { ComponentProps, ReactNode } from "react";
import { XIcon } from "lucide-react";
import { badgeVariants } from "@appstrate/ui/components/badge";
import { NOTE_TEXT_CLASS } from "./phone-text.ts";
import { cn } from "@appstrate/ui/cn";

const ICON = "[&>svg]:size-3.5 [&>svg]:shrink-0";

interface RemovableChipProps extends Omit<ComponentProps<"span">, "children"> {
  icon: ReactNode;
  children: ReactNode;
  removeLabel: string;
  removeDisabled?: boolean;
  onRemove: () => void;
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
    // `rest` carries what a Radix trigger (`asChild`) passes: ref, handlers, data-state.
    <span
      {...rest}
      className={cn(
        badgeVariants({ variant: "secondary" }),
        "text-muted-foreground h-7 max-w-56 min-w-0 shrink gap-1.5 py-0 pr-1 pl-2.5 font-normal",
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
          className={cn("flex min-w-0 items-center gap-1.5 [font:inherit]", ICON)}
        >
          {body}
        </button>
      ) : (
        body
      )}
      <button
        type="button"
        aria-label={removeLabel}
        disabled={removeDisabled}
        onClick={onRemove}
        className="hover:bg-foreground/10 flex size-5 shrink-0 items-center justify-center rounded-full disabled:pointer-events-none disabled:opacity-50"
      >
        <XIcon className="size-3" />
      </button>
    </span>
  );
}
