// SPDX-License-Identifier: Apache-2.0

import { PendingButton } from "@/components/app-ui/pending-button";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { UnsavedBlocker } from "../hooks/use-unsaved-changes";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@appstrate/ui/components/alert-dialog";
import { Button } from "@appstrate/ui/components/button";

interface UnsavedChangesModalProps {
  blocker: UnsavedBlocker;
  /** If provided, shows a "Save draft" button. Should return a promise that resolves on success. */
  onSaveDraft?: () => Promise<void>;
  saveLabel?: string;
}

export function UnsavedChangesModal({ blocker, onSaveDraft, saveLabel }: UnsavedChangesModalProps) {
  const { t } = useTranslation("common");
  const [isSaving, setIsSaving] = useState(false);

  if (blocker.state !== "blocked") return null;

  const handleSave = async () => {
    if (!onSaveDraft) return;
    setIsSaving(true);
    try {
      await onSaveDraft();
      blocker.proceed();
    } catch {
      // The refusal is toasted, and the editor keeps its draft for a retry.
      blocker.reset();
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <AlertDialog open onOpenChange={(v) => !v && blocker.reset()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("unsaved.title")}</AlertDialogTitle>
          <AlertDialogDescription>{t("unsaved.message")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="outline" onClick={() => blocker.reset()} disabled={isSaving}>
            {t("btn.cancel")}
          </Button>
          <Button variant="ghost" onClick={() => blocker.proceed()} disabled={isSaving}>
            {t("unsaved.discard")}
          </Button>
          {onSaveDraft && (
            <PendingButton onClick={handleSave} pending={isSaving}>
              {saveLabel ?? t("unsaved.saveDraft")}
            </PendingButton>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
