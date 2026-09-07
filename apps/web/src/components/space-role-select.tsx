// SPDX-License-Identifier: Apache-2.0

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@appstrate/ui/components/select";
import type { SpaceRoleOption } from "../hooks/use-roles";

/**
 * A role `<Select>` that always shows the value it holds.
 *
 * Radix renders an empty trigger for a value no `SelectItem` declares, so a
 * role the catalog no longer offers — deleted, or outside the caller's
 * grantable set — would read as "no role at all". It is listed under
 * `fallbackLabel` as a disabled item instead, which keeps the row honest and
 * unpickable.
 */
export function SpaceRoleSelect({
  value,
  options,
  fallbackLabel,
  onValueChange,
  disabled,
  id,
  ariaLabel,
  placeholder,
  className,
}: {
  value: string;
  options: SpaceRoleOption[];
  fallbackLabel: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  id?: string;
  ariaLabel?: string;
  placeholder?: string;
  className?: string;
}) {
  return (
    <Select value={value || undefined} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger id={id} aria-label={ariaLabel} className={className}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {!!value && !options.some((option) => option.value === value) && (
            <SelectItem value={value} disabled>
              {fallbackLabel}
            </SelectItem>
          )}
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
