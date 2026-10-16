// SPDX-License-Identifier: Apache-2.0

/**
 * A text setting with an explicit save and cancel.
 */
import { ManualSetting } from "./manual-save";
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
  onCommit: (next: string) => Promise<unknown>;
  disabled?: boolean;
  placeholder?: string;
  maxLength?: number;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <ManualSetting value={value} onSave={(next) => onCommit(next.trim())} disabled={disabled}>
      {(draft, setDraft, pending) => (
        <Input
          value={draft}
          disabled={pending}
          placeholder={placeholder}
          maxLength={maxLength}
          aria-label={ariaLabel}
          className={className}
          onChange={(event) => setDraft(event.target.value)}
        />
      )}
    </ManualSetting>
  );
}
