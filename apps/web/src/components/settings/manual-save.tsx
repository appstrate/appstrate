// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { SaveBar } from "../save-bar";
import { useUnsavedChanges } from "../../hooks/use-unsaved-changes";
import { UnsavedChangesModal } from "../unsaved-changes-modal";
import { useSaveAction } from "../../hooks/use-save-action";

interface ManualSaveProps {
  dirty: boolean;
  saveDisabled?: boolean;
  onSave: () => Promise<void>;
  onDiscard: () => void;
}

type SaveAction = ReturnType<typeof useSaveAction>;

export function SaveControls({
  dirty,
  saveDisabled = false,
  onDiscard,
  action,
}: Omit<ManualSaveProps, "onSave"> & { action: SaveAction }) {
  const { t } = useTranslation("common");
  const { blocker } = useUnsavedChanges(dirty || action.saving);
  if (!dirty && !action.saving) return null;
  return (
    <>
      <SaveBar
        message={t("unsaved.title")}
        pending={action.saving}
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
