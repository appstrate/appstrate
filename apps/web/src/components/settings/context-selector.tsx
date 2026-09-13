// SPDX-License-Identifier: Apache-2.0

/**
 * The selector at the head of a rail group: which organisation, which
 * workspace, which catalogue. One control, so a panel that switches context
 * always switches it the same way.
 */
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@appstrate/ui/components/select";

/**
 * Transparent until it is a dialog's own surface, where the trigger has to
 * paint its own field: the settings overlay reads as one sheet, and a bordered
 * box inside the rail read as a second one.
 */
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
  options: { id: string; name: string }[];
  onValueChange: (value: string) => void;
}) {
  return (
    <Select value={value} disabled={disabled} onValueChange={onValueChange}>
      <SelectTrigger className={TRIGGER} aria-label={label} data-settings-context-selector>
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.id} value={option.id}>
            {option.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
