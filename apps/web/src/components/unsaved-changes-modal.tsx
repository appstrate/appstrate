import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { UnsavedBlocker } from "../hooks/use-unsaved-changes";
import { Modal } from "./modal";
import { Button } from "@/components/ui/button";
import { Spinner } from "./spinner";

interface UnsavedChangesModalProps {
  blocker: UnsavedBlocker;
  /** If provided, shows a "Save draft" button. Should return a promise that resolves on success. */
  onSaveDraft?: () => Promise<void>;
}

export function UnsavedChangesModal({ blocker, onSaveDraft }: UnsavedChangesModalProps) {
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
      toast.error(t("error.generic"));
      blocker.reset();
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={() => blocker.reset()}
      title={t("unsaved.title")}
      actions={
        <>
          <Button variant="outline" onClick={() => blocker.reset()} disabled={isSaving}>
            {t("btn.cancel")}
          </Button>
          <Button variant="ghost" onClick={() => blocker.proceed()} disabled={isSaving}>
            {t("unsaved.discard")}
          </Button>
          {onSaveDraft && (
            <Button onClick={handleSave} disabled={isSaving}>
              {isSaving ? <Spinner /> : t("unsaved.saveDraft")}
            </Button>
          )}
        </>
      }
    >
      <p className="text-sm text-muted-foreground">{t("unsaved.message")}</p>
    </Modal>
  );
}
