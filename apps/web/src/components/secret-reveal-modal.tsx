// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "./modal";
import { CopyBlock } from "./copy-block";
import { Button } from "@appstrate/ui/components/button";

interface Props {
  onClose: () => void;
  title: string;
  /** The secret, shown verbatim: mount this only when the value is meant to be revealed. */
  secret: string;
  /** Warning shown above the secret: what it grants or that it will not be shown again. */
  warning: string;
  /** Anything the secret comes with, under it. */
  children?: ReactNode;
  /** The dialog's own classes. */
  className?: string;
}

/** A secret shown once, with a copy button. Mounted by the caller while the secret is held. */
export function SecretRevealModal({ onClose, title, secret, warning, children, className }: Props) {
  const { t } = useTranslation("common");

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      className={className}
      actions={<Button onClick={onClose}>{t("btn.done")}</Button>}
    >
      <p className="text-warning bg-warning/10 rounded-md px-3 py-2 text-sm">{warning}</p>
      <CopyBlock value={secret} />
      {children}
    </Modal>
  );
}
