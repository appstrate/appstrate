// SPDX-License-Identifier: Apache-2.0

/**
 * A text setting you edit in place: no Edit button, no mode.
 *
 * Commits on blur or Enter, reverts on Escape, and stays quiet when the value
 * did not actually change — so a stray focus never fires a write.
 *
 * Uncontrolled, keyed on the incoming value rather than mirrored into state.
 * The mirror would need an effect to follow the server, and syncing state from
 * an effect is exactly what the Rules-of-React gate rejects
 * (`react-hooks/set-state-in-effect`, see apps/web/CLAUDE.md). Remounting on a
 * value change costs nothing here and needs no state at all.
 */
import { Input } from "@appstrate/ui/components/input";

export function InlineTextSetting({
  type = "text",
  value,
  onCommit,
  disabled,
  placeholder,
  className,
  "aria-label": ariaLabel,
}: {
  type?: "text" | "email";
  value: string;
  onCommit: (next: string) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <Input
      key={value}
      type={type}
      defaultValue={value}
      disabled={disabled}
      placeholder={placeholder}
      aria-label={ariaLabel}
      className={className}
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
