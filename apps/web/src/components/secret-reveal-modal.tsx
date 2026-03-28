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
      <p className="text-sm text-warning bg-warning/10 rounded-md px-3 py-2">
        {t("settings:webhooks.secretWarning")}
      </p>
      <div className="flex items-center gap-2 mt-3 rounded-md border border-border bg-muted/50 px-3 py-2">
        <code className="flex-1 text-xs font-mono text-foreground break-all">{secret}</code>
        <Button
          variant="ghost"
          size="sm"
          className="text-xs text-primary hover:underline shrink-0"
          onClick={handleCopy}
        >
          {copied ? t("common:btn.copied") : t("common:btn.copy")}
        </Button>
      </div>
      <div className="flex justify-end gap-2 mt-4 pt-4 border-t border-border">
        <Button onClick={handleClose}>{t("common:btn.done")}</Button>
      </div>
    </Modal>
  );
}
