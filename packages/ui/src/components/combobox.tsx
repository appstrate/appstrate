// SPDX-License-Identifier: Apache-2.0

import * as React from "react";
import { Check, ChevronsUpDown } from "lucide-react";

import { cn } from "../cn.ts";
import { Badge } from "./badge.tsx";
import { Button } from "./button.tsx";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "./command.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./popover.tsx";

interface ComboboxOption {
  value: string;
  /** Shown in the list and in the trigger; defaults to `value`. */
  label?: React.ReactNode;
  /** What the search matches besides `value` — the label's text when `value` is an opaque key. */
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

/** The open list shared by both comboboxes: a search field over the options, a tick on the picked ones. */
function ComboboxList({
  options,
  isSelected,
  onPick,
  searchPlaceholder,
  emptyText,
}: {
  options: ComboboxOption[];
  isSelected: (value: string) => boolean;
  onPick: (value: string) => void;
  searchPlaceholder: string;
  emptyText: string;
}) {
  return (
    <Command>
      <CommandInput placeholder={searchPlaceholder} />
      <CommandList>
        <CommandEmpty>{emptyText}</CommandEmpty>
        {options.map((option) => (
          <CommandItem
            key={option.value}
            value={option.value}
            keywords={option.keywords}
            onSelect={() => onPick(option.value)}
          >
            <span className="truncate">{option.label ?? option.value}</span>
            <Check
              className={cn("ml-auto", isSelected(option.value) ? "opacity-100" : "opacity-0")}
            />
          </CommandItem>
        ))}
      </CommandList>
    </Command>
  );
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
      <PopoverTrigger asChild>
        <Button
          id={id}
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn("w-full justify-between font-normal", className)}
        >
          {value === "" && placeholder ? (
            <span className="text-muted-foreground truncate">{placeholder}</span>
          ) : (
            <span className="truncate">{selected?.label ?? selected?.value ?? value}</span>
          )}
          <ChevronsUpDown className="text-muted-foreground shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
        <ComboboxList
          options={options}
          isSelected={(v) => v === value}
          onPick={(v) => {
            onValueChange(clearable && v === value ? "" : v);
            setOpen(false);
          }}
          searchPlaceholder={searchPlaceholder}
          emptyText={emptyText}
        />
      </PopoverContent>
    </Popover>
  );
}

interface MultiComboboxProps extends Omit<ComboboxProps, "value" | "onValueChange" | "clearable"> {
  value: string[];
  onValueChange: (value: string[]) => void;
}

/** A searchable multi select: the picked options stay in the trigger as badges. */
function MultiCombobox({
  id,
  value,
  onValueChange,
  options,
  searchPlaceholder,
  emptyText,
  placeholder,
  disabled,
  className,
}: MultiComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const picked = options.filter((option) => value.includes(option.value));
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn("h-auto min-h-9 w-full justify-between font-normal", className)}
        >
          <span className="flex flex-wrap gap-1">
            {picked.length === 0 && placeholder ? (
              <span className="text-muted-foreground">{placeholder}</span>
            ) : (
              picked.map((option) => (
                <Badge key={option.value} variant="secondary">
                  {option.label ?? option.value}
                </Badge>
              ))
            )}
          </span>
          <ChevronsUpDown className="text-muted-foreground shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
        <ComboboxList
          options={options}
          isSelected={(v) => value.includes(v)}
          onPick={(v) =>
            onValueChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v])
          }
          searchPlaceholder={searchPlaceholder}
          emptyText={emptyText}
        />
      </PopoverContent>
    </Popover>
  );
}

export { Combobox, MultiCombobox };
