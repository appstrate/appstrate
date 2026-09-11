// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Modal } from "./modal";
import { Button } from "@appstrate/ui/components/button";
import { Spinner } from "./spinner";

interface ConfirmModalProps {
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
}: ConfirmModalProps) {
  const { t } = useTranslation("common");

  return (
    <Modal
      open={open}
      onClose={onClose}
      preventClose={isPending}
      title={title}
      actions={
        <>
          <Button variant="outline" onClick={onClose} disabled={isPending}>
            {t("btn.cancel")}
          </Button>
          <Button variant={variant} onClick={onConfirm} disabled={isPending || confirmDisabled}>
            {isPending ? <Spinner label={t("loading")} /> : (confirmLabel ?? t("btn.confirm"))}
          </Button>
        </>
      }
    >
      <p className="text-muted-foreground text-sm">{description}</p>
    </Modal>
  );
}
