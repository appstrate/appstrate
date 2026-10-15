// SPDX-License-Identifier: Apache-2.0

/**
 * Edit-in-place text: commits on blur/Enter (only if changed), reverts on Escape.
 * Uncontrolled and keyed on `value`: mirroring into state would need a set-state-in-effect.
 * `data-inline-editing` keeps Escape from closing the surrounding dialog (`keepOpenWhileRenaming`).
 */
import { Input } from "@appstrate/ui/components/input";

export function InlineTextSetting({
  value,
  onCommit,
  disabled,
  placeholder,
  maxLength,
  className,
  "aria-label": ariaLabel,
}: {
  value: string;
  onCommit: (next: string) => void;
  disabled?: boolean;
  placeholder?: string;
  maxLength?: number;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <Input
      key={value}
      defaultValue={value}
      disabled={disabled}
      placeholder={placeholder}
      maxLength={maxLength}
      aria-label={ariaLabel}
      className={className}
      data-inline-editing=""
      onBlur={(e) => {
        const next = e.currentTarget.value.trim();
        if (!next || next === value) {
          e.currentTarget.value = value;
          return;
        }
        onCommit(next);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        }
        if (e.key === "Escape") {
          e.currentTarget.value = value;
          e.currentTarget.blur();
        }
      }}
    />
  );
}
