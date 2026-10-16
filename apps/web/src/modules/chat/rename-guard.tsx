// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import type { RenameGuardProps } from "@appstrate/module-chat/ui";
import { useUnsavedChanges } from "../../hooks/use-unsaved-changes";
import { UnsavedChangesModal } from "../../components/unsaved-changes-modal";

/** The module delegates navigation protection to the shell that owns its router. */
export function ChatRenameGuard({ dirty, onSave }: RenameGuardProps) {
  const { t } = useTranslation("common");
  const { blocker } = useUnsavedChanges(dirty);
  return <UnsavedChangesModal blocker={blocker} onSaveDraft={onSave} saveLabel={t("btn.save")} />;
}
