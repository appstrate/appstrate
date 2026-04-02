// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "./modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface ApiKeyModalProps {
  open: boolean;
  onClose: () => void;
  providerName: string;
  isPending: boolean;
  onSubmit: (apiKey: string) => void;
}

export function ApiKeyModal({
  open,
  onClose,
  providerName,
  isPending,
  onSubmit,
}: ApiKeyModalProps) {
  const { t } = useTranslation(["settings", "common"]);
  const [apiKey, setApiKey] = useState("");

  const handleClose = () => {
    setApiKey("");
    onClose();
  };

  const handleSubmit = () => {
    if (apiKey.trim()) {
      onSubmit(apiKey.trim());
    }
  };

  return (
    <Modal open={open} onClose={handleClose} title={t("apiKey.title", { name: providerName })}>
      <div className="space-y-2">
        <Label htmlFor="api-key-input">{t("apiKey.label")}</Label>
        <Input
          id="api-key-input"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={t("apiKey.placeholder", { name: providerName })}
          onKeyDown={(e) => {
            if (e.key === "Enter" && apiKey.trim() && !isPending) handleSubmit();
          }}
        />
      </div>
      <div className="border-border mt-4 flex justify-end gap-2 border-t pt-4">
        <Button variant="outline" onClick={handleClose}>
          {t("btn.cancel")}
        </Button>
        <Button onClick={handleSubmit} disabled={!apiKey.trim() || isPending}>
          {t("btn.connect")}
        </Button>
      </div>
    </Modal>
  );
}
