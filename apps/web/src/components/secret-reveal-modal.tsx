// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "./modal";
import { Button } from "@/components/ui/button";

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  secret: string;
}

export function SecretRevealModal({ open, onClose, title, secret }: Props) {
  const { t } = useTranslation(["settings", "common"]);
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(secret);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleClose() {
    setCopied(false);
    onClose();
  }

  return (
    <Modal open={open} onClose={handleClose} title={title}>
      <p className="text-warning bg-warning/10 rounded-md px-3 py-2 text-sm">
        {t("settings:webhooks.secretWarning")}
      </p>
      <div className="border-border bg-muted/50 mt-3 flex items-center gap-2 rounded-md border px-3 py-2">
        <code className="text-foreground flex-1 font-mono text-xs break-all">{secret}</code>
        <Button
          variant="ghost"
          size="sm"
          className="text-primary shrink-0 text-xs hover:underline"
          onClick={handleCopy}
        >
          {copied ? t("common:btn.copied") : t("common:btn.copy")}
        </Button>
      </div>
      <div className="border-border mt-4 flex justify-end gap-2 border-t pt-4">
        <Button onClick={handleClose}>{t("common:btn.done")}</Button>
      </div>
    </Modal>
  );
}
