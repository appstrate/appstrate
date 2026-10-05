// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "./modal";
import { Button } from "@appstrate/ui/components/button";
import { Spinner } from "./spinner";
import { IDLE_CONFIRM, confirmClick, confirmCommit } from "../lib/confirm-settle";

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
   * Keep the dialog open once the confirmed action settles. Only for a dialog
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
  const record = useRef(IDLE_CONFIRM);

  useEffect(() => {
    const commit = confirmCommit(record.current, { isPending: !!isPending, open });
    record.current = commit.record;
    if (commit.settled && !keepOpenOnSettle) onClose();
  }, [isPending, open, keepOpenOnSettle, onClose]);

  const confirm = () => {
    const click = confirmClick(record.current);
    record.current = click.record;
    if (click.accepted) onConfirm();
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
