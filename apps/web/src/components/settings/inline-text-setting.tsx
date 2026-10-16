// SPDX-License-Identifier: Apache-2.0

/**
 * A text setting saved by Save or Enter, cancelled by Cancel or Escape; blur never saves.
 * An empty value cannot be saved. `data-inline-editing` keeps Escape from closing the
 * surrounding dialog (`keepOpenWhileRenaming`).
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
    <ManualSetting
      value={value}
      onSave={(next) => onCommit(next.trim())}
      disabled={disabled}
      canSave={(next) => next.trim() !== "" && next.trim() !== value}
    >
      {(draft, setDraft, pending, { submit, discard }) => (
        <Input
          value={draft}
          disabled={pending}
          placeholder={placeholder}
          maxLength={maxLength}
          aria-label={ariaLabel}
          className={className}
          data-inline-editing=""
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            }
            if (event.key === "Escape") discard();
          }}
        />
      )}
    </ManualSetting>
  );
}
