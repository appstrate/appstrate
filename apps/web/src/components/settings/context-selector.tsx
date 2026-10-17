// SPDX-License-Identifier: Apache-2.0

import { IdentityTile } from "@appstrate/ui/components/identity-tile";
import { OptionSelect } from "@/components/app-ui/option-select";
import type { IdentityTileProps } from "@/lib/space-label";

/** Transparent in the rail so the settings overlay reads as one sheet; bordered from `md`. */
const TRIGGER = [
  "relative h-11 border-transparent bg-transparent py-0 shadow-none",
  "before:pointer-events-none before:absolute before:inset-x-0 before:inset-y-0.5",
  "before:rounded-md before:border before:border-input before:bg-background before:shadow-sm",
  "[&>span]:relative [&>span]:z-10 [&>svg]:relative [&>svg]:z-10",
  "md:h-9 md:border-input md:bg-background md:py-2 md:shadow-sm md:before:hidden",
].join(" ");

export function ContextSelector({
  value,
  label,
  disabled,
  options,
  onValueChange,
}: {
  value: string;
  label: string;
  disabled?: boolean;
  /** `tile`: the `IdentityTile` drawn before the name, in the list and on the trigger. */
  options: { id: string; name: string; tile: IdentityTileProps; disabled?: boolean }[];
  onValueChange: (value: string) => void;
}) {
  return (
    <OptionSelect
      value={value}
      disabled={disabled}
      onValueChange={onValueChange}
      placeholder={label}
      className={TRIGGER}
      aria-label={label}
      options={options.map((option) => ({
        value: option.id,
        label: (
          <span className="flex min-w-0 items-center gap-2">
            <IdentityTile {...option.tile} className="size-5 rounded-md" />
            <span className="truncate">{option.name}</span>
          </span>
        ),
        disabled: option.disabled,
      }))}
    />
  );
}
