// SPDX-License-Identifier: Apache-2.0

import { useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { SaveBar } from "../save-bar";
import { useUnsavedChanges } from "../../hooks/use-unsaved-changes";
import { useSettingDraft } from "../../hooks/use-setting-draft";
import { UnsavedChangesModal } from "../unsaved-changes-modal";
import { errorMessage } from "../../lib/mutation-error";

export function ManualSave({
  dirty,
  compact = false,
  pending = false,
  saveDisabled = false,
  onSave,
  onDiscard,
}: {
  dirty: boolean;
  compact?: boolean;
  pending?: boolean;
  saveDisabled?: boolean;
  onSave: () => Promise<void>;
  onDiscard: () => void;
}) {
  const { t } = useTranslation("common");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const { blocker } = useUnsavedChanges(dirty || saving || pending);
  const inFlight = useRef<Promise<void> | null>(null);
  const save = () => {
    if (inFlight.current) return inFlight.current;
    setSaving(true);
    setError(null);
    const work = onSave()
      .catch((cause: unknown) => {
        if (!(cause instanceof DOMException && cause.name === "AbortError")) setError(cause);
        throw cause;
      })
      .finally(() => {
        inFlight.current = null;
        setSaving(false);
      });
    inFlight.current = work;
    return work;
  };

  if (!dirty && !saving && !pending) return null;
  return (
    <>
      <SaveBar
        compact={compact}
        message={t("unsaved.title")}
        pending={saving || pending}
        saveDisabled={saveDisabled}
        onDiscard={() => {
          setError(null);
          onDiscard();
        }}
        onSave={() => {
          void save().catch(() => {});
        }}
      />
      {error != null && (
        <p className="text-destructive text-sm" role="alert">
          {errorMessage(error)}
        </p>
      )}
      <UnsavedChangesModal
        blocker={blocker}
        onSaveDraft={saveDisabled ? undefined : save}
        saveLabel={t("btn.save")}
      />
    </>
  );
}

/** A small independent setting; larger forms use the same draft and save bar directly. */
export function ManualSetting<T>({
  value,
  onSave,
  children,
  compact = false,
  disabled = false,
}: {
  value: T;
  compact?: boolean;
  onSave: (value: T) => Promise<unknown>;
  children: (value: T, onChange: (next: T) => void, pending: boolean) => ReactNode;
  disabled?: boolean;
}) {
  const draft = useSettingDraft(value);
  const [pending, setPending] = useState(false);
  const save = async () => {
    const sent = draft.value;
    setPending(true);
    try {
      await onSave(sent);
      draft.accept(sent);
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="w-full min-w-0">
      {children(draft.value, draft.set, pending || disabled)}
      <ManualSave
        compact={compact}
        dirty={draft.dirty}
        pending={pending}
        saveDisabled={disabled}
        onSave={save}
        onDiscard={draft.reset}
      />
    </div>
  );
}
