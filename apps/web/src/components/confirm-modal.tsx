// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Modal } from "./modal";
import { Button } from "@appstrate/ui/components/button";
import { Spinner } from "./spinner";
import { trackConfirm } from "../lib/confirm-settle";

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
  /**
   * Keep the dialog open when the confirmed action is refused. Only for a dialog
   * that shows the refusal itself (the role deletion's « still held by N »):
   * every other one closes, since a refusal is reported by a toast and
   * confirming again would only be refused again.
   */
  keepOpenOnSettle?: boolean;
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
  keepOpenOnSettle,
  children,
}: ConfirmModalProps) {
  const { t } = useTranslation("common");
  const mutationCache = useQueryClient().getMutationCache();
  // A ref, not state: the second click of a double-click lands before any
  // re-render could disable the button.
  const confirming = useRef(false);
  const latest = useRef({ open, keepOpenOnSettle, onClose });
  useEffect(() => {
    latest.current = { open, keepOpenOnSettle, onClose };
  });

  const confirm = () => {
    if (confirming.current) return;
    confirming.current = true;
    trackConfirm(mutationCache, onConfirm, (refused) => {
      confirming.current = false;
      // A success is closed by the caller's `onSuccess`; a refusal is reported
      // by a toast, and confirming again would only be refused again.
      const now = latest.current;
      if (refused && now.open && !now.keepOpenOnSettle) now.onClose();
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      actions={
        <>
          <Button variant="outline" onClick={onClose} disabled={isPending}>
            {t("btn.cancel")}
          </Button>
          <Button variant={variant} onClick={confirm} disabled={isPending || confirmDisabled}>
            {isPending ? <Spinner /> : (confirmLabel ?? t("btn.confirm"))}
          </Button>
        </>
      }
    >
      <p className="text-muted-foreground text-sm">{description}</p>
      {children}
    </Modal>
  );
}
