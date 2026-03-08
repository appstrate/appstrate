import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "./modal";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

interface ShareLinkModalProps {
  open: boolean;
  onClose: () => void;
  url: string;
}

export function ShareLinkModal({ open, onClose, url }: ShareLinkModalProps) {
  const { t } = useTranslation("flows");
  const [copied, setCopied] = useState(false);

  const copy = () => {
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("share.linkModalTitle")}
      actions={
        <Button onClick={copy}>{copied ? t("share.copied") : t("share.copyToClipboard")}</Button>
      }
    >
      <Input readOnly value={url} onFocus={(e) => e.target.select()} />
    </Modal>
  );
}
