import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "./modal";

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
      <div className="form-group">
        <label htmlFor="api-key-input">{t("apiKey.label")}</label>
        <input
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
      <div className="modal-actions">
        <button onClick={handleClose}>{t("btn.cancel")}</button>
        <button className="primary" onClick={handleSubmit} disabled={!apiKey.trim() || isPending}>
          {t("btn.connect")}
        </button>
      </div>
    </Modal>
  );
}
