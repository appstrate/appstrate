// SPDX-License-Identifier: Apache-2.0

import { useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { SaveBar } from "../save-bar";
import { useUnsavedChanges } from "../../hooks/use-unsaved-changes";
import { useSettingDraft } from "../../hooks/use-setting-draft";
import { UnsavedChangesModal } from "../unsaved-changes-modal";

interface ManualSaveProps {
  dirty: boolean;
  compact?: boolean;
  /** Work outside `onSave` that must hold the bar and the guard (e.g. preparing an image). */
  pending?: boolean;
  saveDisabled?: boolean;
  onSave: () => Promise<void>;
  onDiscard: () => void;
}

/**
 * One save at a time: the leave dialog's Save joins a write already in flight. A refusal is
 * told by the mutation's own toast (`lib/query-client.ts`); the draft stays for a retry.
 */
function useSaveAction(onSave: () => Promise<void>) {
  const [saving, setSaving] = useState(false);
  const inFlight = useRef<Promise<void> | null>(null);
  const save = () => {
    if (inFlight.current) return inFlight.current;
    setSaving(true);
    const work = onSave().finally(() => {
      inFlight.current = null;
      setSaving(false);
    });
    inFlight.current = work;
    return work;
  };
  return { save, saving };
}

type SaveAction = ReturnType<typeof useSaveAction>;

function SaveControls({
  dirty,
  compact = false,
  pending = false,
  saveDisabled = false,
  onDiscard,
  action,
}: Omit<ManualSaveProps, "onSave"> & { action: SaveAction }) {
  const { t } = useTranslation("common");
  const { blocker } = useUnsavedChanges(dirty || action.saving || pending);
  if (!dirty && !action.saving && !pending) return null;
  return (
    <>
      <SaveBar
        compact={compact}
        message={t("unsaved.title")}
        pending={action.saving || pending}
        saveDisabled={saveDisabled}
        onDiscard={onDiscard}
        onSave={() => {
          void action.save().catch(() => {});
        }}
      />
      <UnsavedChangesModal
        blocker={blocker}
        onSaveDraft={saveDisabled ? undefined : action.save}
        saveLabel={t("btn.save")}
      />
    </>
  );
}

export function ManualSave(props: ManualSaveProps) {
  const action = useSaveAction(props.onSave);
  return <SaveControls {...props} action={action} />;
}

/**
 * A small independent setting; larger forms use the same draft and save bar directly.
 * `submit` lets a field save from the keyboard (Enter) through the same path as the button.
 */
export function ManualSetting<T>({
  value,
  onSave,
  children,
  compact = false,
  disabled = false,
  canSave,
}: {
  value: T;
  compact?: boolean;
  onSave: (value: T) => Promise<unknown>;
  children: (
    value: T,
    onChange: (next: T) => void,
    pending: boolean,
    controls: { submit: () => void; discard: () => void },
  ) => ReactNode;
  disabled?: boolean;
  /** A draft that is not a valid value cannot be saved. */
  canSave?: (value: T) => boolean;
}) {
  const draft = useSettingDraft(value);
  const action = useSaveAction(async () => {
    const sent = draft.value;
    await onSave(sent);
    draft.accept(sent);
  });
  const saveDisabled = disabled || (canSave !== undefined && !canSave(draft.value));
  const submit = () => {
    if (draft.dirty && !saveDisabled) void action.save().catch(() => {});
  };
  return (
    <div className="w-full min-w-0">
      {children(draft.value, draft.set, action.saving || disabled, {
        submit,
        discard: draft.reset,
      })}
      <SaveControls
        compact={compact}
        dirty={draft.dirty}
        saveDisabled={saveDisabled}
        onDiscard={draft.reset}
        action={action}
      />
    </div>
  );
}
