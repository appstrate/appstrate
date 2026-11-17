// SPDX-License-Identifier: Apache-2.0

import { PendingButton } from "@/components/app-ui/pending-button";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@appstrate/ui/components/alert-dialog";
import { Button } from "@appstrate/ui/components/button";
import { keepOpenWhileRenaming } from "../lib/keep-open-while-renaming";
import { createConfirmer } from "../lib/confirm-settle";
import { useDialogFocus } from "../hooks/use-dialog-focus";

interface ConfirmModalProps {
  /** Extra content under the description, for a decision that needs more than a sentence. */
  children?: ReactNode;
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description: string;
  confirmLabel?: string;
  variant?: "default" | "destructive";
  isPending?: boolean;
  /** The action cannot go ahead: the description says why, and only Cancel answers. */
  confirmDisabled?: boolean;
  /** For a dialog that shows the refusal itself: every other one closes on it, a toast says why. */
  keepOpenOnRefusal?: boolean;
}

export function ConfirmModal({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel,
  variant = "destructive",
  isPending,
  confirmDisabled,
  keepOpenOnRefusal,
  children,
}: ConfirmModalProps) {
  const focus = useDialogFocus();
  const { t } = useTranslation("common");
  const mutationCache = useQueryClient().getMutationCache();
  const [runConfirm] = useState(() => createConfirmer(mutationCache));
  const latest = useRef({ open, keepOpenOnRefusal, onClose });
  useEffect(() => {
    latest.current = { open, keepOpenOnRefusal, onClose };
  });

  // A success is closed by the caller's `onSuccess`.
  const confirm = () =>
    runConfirm(onConfirm, () => {
      const now = latest.current;
      if (now.open && !now.keepOpenOnRefusal) now.onClose();
    });

  return (
    <AlertDialog open={open} onOpenChange={(v) => !v && !isPending && onClose()}>
      <AlertDialogContent {...focus} onEscapeKeyDown={keepOpenWhileRenaming}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {children}
        <AlertDialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isPending}>
            {t("btn.cancel")}
          </Button>
          <PendingButton
            variant={variant}
            onClick={confirm}
            pending={isPending}
            disabled={confirmDisabled}
          >
            {confirmLabel ?? t("btn.confirm")}
          </PendingButton>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
