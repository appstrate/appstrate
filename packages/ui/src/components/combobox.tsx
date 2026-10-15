// SPDX-License-Identifier: Apache-2.0

import * as React from "react";
import { Check, ChevronsUpDown } from "lucide-react";

import { cn } from "../cn.ts";
import { Button } from "./button.tsx";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "./command.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./popover.tsx";

interface ComboboxOption {
  value: string;
  /** Shown in the list and in the trigger; defaults to `value`. */
  label?: React.ReactNode;
}

interface ComboboxProps {
  id?: string;
  value: string;
  onValueChange: (value: string) => void;
  options: ComboboxOption[];
  searchPlaceholder: string;
  emptyText: string;
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
  disabled,
  className,
}: ComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const selected = options.find((option) => option.value === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn("w-full justify-between font-normal", className)}
        >
          <span className="truncate">{selected?.label ?? selected?.value ?? value}</span>
          <ChevronsUpDown className="text-muted-foreground shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            {options.map((option) => (
              <CommandItem
                key={option.value}
                value={option.value}
                onSelect={() => {
                  onValueChange(option.value);
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

export { Combobox, type ComboboxOption };
