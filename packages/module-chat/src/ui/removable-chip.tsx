// SPDX-License-Identifier: Apache-2.0

/**
 * A composer setting that departs from the default, shown as a chip whose X restores the default.
 * With `open`, the chip's body is itself a button (it reopens the setting's picker).
 */

import type { ComponentProps, ReactNode } from "react";
import { XIcon } from "lucide-react";
import { badgeVariants } from "@appstrate/ui/components/badge";
import { cn } from "@appstrate/ui/cn";

interface RemovableChipProps extends Omit<ComponentProps<"span">, "children"> {
  icon: ReactNode;
  children: ReactNode;
  removeLabel: string;
  removeDisabled?: boolean;
  onRemove: () => void;
  testId?: string;
  removeTestId?: string;
  open?: { onClick: () => void; label: string; testId?: string };
}

export function RemovableChip({
  icon,
  children,
  removeLabel,
  removeDisabled = false,
  onRemove,
  testId,
  removeTestId,
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
      data-testid={testId}
      className={cn(
        badgeVariants({ variant: "secondary" }),
        "text-muted-foreground h-7 max-w-56 min-w-0 shrink gap-1.5 py-0 pr-1 pl-2.5 font-normal [&_svg]:size-3.5 [&_svg]:shrink-0",
        className,
      )}
    >
      {open ? (
        <button
          type="button"
          aria-label={open.label}
          data-testid={open.testId}
          onClick={open.onClick}
          className="flex min-w-0 items-center gap-1.5 [font:inherit]"
        >
          {body}
        </button>
      ) : (
        body
      )}
      <button
        type="button"
        aria-label={removeLabel}
        data-testid={removeTestId}
        disabled={removeDisabled}
        onClick={onRemove}
        className="hover:bg-foreground/10 flex size-5 shrink-0 items-center justify-center rounded-full disabled:pointer-events-none disabled:opacity-50"
      >
        <XIcon className="!size-3" />
      </button>
    </span>
  );
}
