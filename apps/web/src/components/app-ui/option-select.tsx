// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@appstrate/ui/components/select";

export interface SelectOption {
  value: string;
  label: ReactNode;
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
  /** Items drawn above the options (a "none" choice, a kept unknown value). */
  leading?: ReactNode;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
}) {
  return (
    <Select value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger id={id} className={className} {...aria}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className={contentClassName}>
        {leading}
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
