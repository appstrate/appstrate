// SPDX-License-Identifier: Apache-2.0

import * as React from "react";
import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import { Check, ChevronsUpDown, X } from "lucide-react";

import { cn } from "../cn.ts";
import { Button } from "./button.tsx";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "./command.tsx";
import type { WithClassName } from "./primitive-props.ts";
import { Popover, PopoverContent, PopoverTrigger } from "./popover.tsx";

interface ComboboxOption {
  value: string;
  /** Shown in the list and in the trigger; defaults to `value`. */
  label?: React.ReactNode;
  /** What the search matches besides `value`: the label's text when `value` is an opaque key. */
  keywords?: string[];
}

interface ComboboxProps {
  id?: string;
  value: string;
  onValueChange: (value: string) => void;
  options: ComboboxOption[];
  searchPlaceholder: string;
  emptyText: string;
  /** Shown while nothing is selected. */
  placeholder?: string;
  /** Picking the selected option again clears the value (`""`). */
  clearable?: boolean;
  disabled?: boolean;
  className?: string;
}

/** A searchable single select: Popover + Command, sized to its trigger. */
function Combobox({
  id,
  value,
  onValueChange,
  options,
  searchPlaceholder,
  emptyText,
  placeholder,
  clearable,
  disabled,
  className,
}: ComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const selected = options.find((option) => option.value === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            id={id}
            variant="outline"
            role="combobox"
            disabled={disabled}
            className={cn("w-full justify-between font-normal", className)}
          />
        }
      >
        <span className={cn("truncate", !value && "text-muted-foreground")}>
          {value ? (selected?.label ?? selected?.value ?? value) : placeholder}
        </span>
        <ChevronsUpDown className="text-muted-foreground shrink-0" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-(--anchor-width) p-0">
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            {options.map((option) => (
              <CommandItem
                key={option.value}
                value={option.value}
                keywords={option.keywords}
                onSelect={() => {
                  onValueChange(clearable && option.value === value ? "" : option.value);
                  setOpen(false);
                }}
              >
                <span className="truncate">{option.label ?? option.value}</span>
                <Check
                  className={cn("ml-auto", option.value === value ? "opacity-100" : "opacity-0")}
                />
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Multiple selection, drawn as chips. Compose them inside Base UI's `Combobox.Root` (given
 * `multiple`): the `Combobox` above is a single, Popover-based select and shares nothing with it.
 */
const ComboboxValue = ComboboxPrimitive.Value;

function ComboboxChips({
  className,
  ref,
  ...props
}: WithClassName<ComboboxPrimitive.Chips.Props> & { ref?: React.Ref<HTMLDivElement> }) {
  return (
    <ComboboxPrimitive.Chips
      ref={ref}
      data-slot="combobox-chips"
      className={cn(
        "border-input bg-background focus-within:ring-ring has-aria-invalid:border-destructive has-aria-invalid:ring-destructive/20 flex min-h-10 w-full flex-wrap items-center gap-1.5 rounded-md border bg-clip-padding px-2.5 py-1.5 text-sm transition-colors focus-within:ring-2 has-data-[slot=combobox-chip]:px-1.5",
        className,
      )}
      {...props}
    />
  );
}

function ComboboxChip({
  className,
  children,
  showRemove = true,
  ...props
}: WithClassName<ComboboxPrimitive.Chip.Props> & { showRemove?: boolean }) {
  return (
    <ComboboxPrimitive.Chip
      data-slot="combobox-chip"
      className={cn(
        "bg-muted text-foreground flex h-[calc(--spacing(5.5))] w-fit items-center justify-center gap-1 rounded-sm px-1.5 text-xs font-medium whitespace-nowrap has-disabled:pointer-events-none has-disabled:cursor-not-allowed has-disabled:opacity-50 has-data-[slot=combobox-chip-remove]:pr-0",
        className,
      )}
      {...props}
    >
      {children}
      {showRemove && (
        <ComboboxPrimitive.ChipRemove
          data-slot="combobox-chip-remove"
          className="hover:bg-accent -ml-1 inline-flex size-5 items-center justify-center rounded-sm opacity-50 hover:opacity-100"
        >
          <X className="size-3" />
        </ComboboxPrimitive.ChipRemove>
      )}
    </ComboboxPrimitive.Chip>
  );
}

function ComboboxChipsInput({ className, ...props }: WithClassName<ComboboxPrimitive.Input.Props>) {
  return (
    <ComboboxPrimitive.Input
      data-slot="combobox-chip-input"
      className={cn("min-w-16 flex-1 bg-transparent outline-none", className)}
      {...props}
    />
  );
}

export { Combobox, ComboboxChip, ComboboxChips, ComboboxChipsInput, ComboboxValue };
