// SPDX-License-Identifier: Apache-2.0

/**
 * A text setting saved by Save or Enter, cancelled by Cancel or Escape; blur never saves.
 * An empty value cannot be saved. `data-inline-editing` keeps Escape from closing the
 * surrounding dialog (`keepOpenWhileRenaming`).
 */
import { Input } from "@appstrate/ui/components/input";
import { useSettingDraft } from "../../hooks/use-setting-draft";
import { useSaveAction } from "../../hooks/use-save-action";
import { SaveControls } from "./manual-save";

export function InlineTextSetting({
  value,
  onCommit,
  disabled = false,
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
  const draft = useSettingDraft(value);
  const action = useSaveAction(async () => {
    const sent = draft.value;
    await onCommit(sent.trim());
    draft.accept(sent);
  });
  const next = draft.value.trim();
  const saveDisabled = disabled || next === "" || next === value;
  return (
    <div className="w-full min-w-0">
      <Input
        value={draft.value}
        disabled={action.saving || disabled}
        placeholder={placeholder}
        maxLength={maxLength}
        aria-label={ariaLabel}
        className={className}
        data-inline-editing=""
        onChange={(event) => draft.set(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            if (draft.dirty && !saveDisabled) void action.save().catch(() => {});
          }
          if (event.key === "Escape") draft.reset();
        }}
      />
      <SaveControls
        dirty={draft.dirty}
        saveDisabled={saveDisabled}
        onDiscard={draft.reset}
        action={action}
      />
    </div>
  );
}
