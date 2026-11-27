// SPDX-License-Identifier: Apache-2.0

import { OptionSelect } from "./app-ui/option-select";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { cn } from "@appstrate/ui/cn";
import type { SpaceRoleOption } from "../hooks/use-roles";

/**
 * A role `<Select>` that always shows the value it holds.
 *
 * A select draws the raw value for a value no option labels, so a
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
  ariaLabelledBy,
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
  ariaLabelledBy?: string;
  placeholder?: string;
  className?: string;
}) {
  if (loading) return <Skeleton className={cn("h-10 w-full", className)} />;

  return (
    <OptionSelect
      value={value || undefined}
      onValueChange={onValueChange}
      disabled={disabled}
      id={id}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      className={className}
      placeholder={placeholder}
      options={options}
      leading={
        value && !options.some((option) => option.value === value)
          ? [{ value, label: fallbackLabel, disabled: true }]
          : undefined
      }
    />
  );
}
