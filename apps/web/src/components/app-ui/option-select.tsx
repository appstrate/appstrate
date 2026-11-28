// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@appstrate/ui/components/select";

export interface SelectOption {
  value: string;
  label: ReactNode;
  /** The text typeahead matches, when `label` is not plain text (read from the item's text otherwise). */
  textValue?: string;
  disabled?: boolean;
}

/** A shadcn `Select` over a flat list of options: the one shape most forms need. */
export function OptionSelect({
  id,
  value,
  onValueChange,
  options,
  placeholder,
  disabled,
  className,
  contentClassName,
  leading,
  ...aria
}: {
  id?: string;
  value: string | undefined;
  onValueChange: (value: string) => void;
  options: readonly SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  /** On the trigger. */
  className?: string;
  contentClassName?: string;
  /** Options drawn above the others (a "none" choice, a kept unknown value). */
  leading?: readonly SelectOption[];
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
}) {
  const all = leading ? [...leading, ...options] : options;
  // The trigger draws the chosen option's label, not its value.
  const items = Object.fromEntries(all.map((option) => [option.value, option.label]));
  return (
    <Select value={value ?? null} onValueChange={onValueChange} disabled={disabled} items={items}>
      <SelectTrigger id={id} className={className} {...aria}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className={contentClassName}>
        <SelectGroup>
          {all.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              label={option.textValue}
              disabled={option.disabled}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
