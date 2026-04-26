// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Modal } from "./modal";
import { RevealedSecret } from "./revealed-secret";
import { Button } from "@/components/ui/button";

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  secret: string;
}

export function SecretRevealModal({ open, onClose, title, secret }: Props) {
  const { t } = useTranslation(["settings", "common"]);

  return (
    <Modal open={open} onClose={onClose} title={title}>
      <RevealedSecret secret={secret} warning={t("settings:webhooks.secretWarning")} />
      <div className="border-border mt-4 flex justify-end gap-2 border-t pt-4">
        <Button onClick={onClose}>{t("common:btn.done")}</Button>
      </div>
    </Modal>
  );
}
