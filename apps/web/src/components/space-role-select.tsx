// SPDX-License-Identifier: Apache-2.0

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@appstrate/ui/components/select";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { cn } from "@appstrate/ui/cn";
import type { SpaceRoleOption } from "../hooks/use-roles";

/**
 * A role `<Select>` that always shows the value it holds.
 *
 * Radix renders an empty trigger for a value no `SelectItem` declares, so a
 * role the catalog no longer offers — deleted, or outside the caller's
 * grantable set — would read as "no role at all". It is listed under
 * `fallbackLabel` as a disabled item instead, which keeps the row honest and
 * unpickable.
 *
 * While the catalog loads (`loading`) a block of the trigger's size stands in:
 * a disabled trigger would claim "no assignable role" for a list not yet read.
 */
export function SpaceRoleSelect({
  value,
  options,
  fallbackLabel,
  onValueChange,
  disabled,
  loading,
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
  loading?: boolean;
  id?: string;
  ariaLabel?: string;
  placeholder?: string;
  className?: string;
}) {
  if (loading) return <Skeleton className={cn("h-9 w-full", className)} />;

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
