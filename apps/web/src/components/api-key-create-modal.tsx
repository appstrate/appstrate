import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "./modal";
import { Spinner } from "./spinner";
import { useCreateApiKey } from "../hooks/use-api-keys";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function ApiKeyCreateModal({ open, onClose }: Props) {
  const { t } = useTranslation(["settings", "common"]);
  const createMutation = useCreateApiKey();

  const [name, setName] = useState("");
  const [expiresIn, setExpiresIn] = useState("90");
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleClose = () => {
    setName("");
    setExpiresIn("90");
    setCreatedKey(null);
    setCopied(false);
    createMutation.reset();
    onClose();
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const expiresAt =
      expiresIn === "never"
        ? null
        : new Date(Date.now() + parseInt(expiresIn, 10) * 24 * 60 * 60 * 1000).toISOString();

    createMutation.mutate(
      { name: name.trim(), expiresAt },
      {
        onSuccess: (data) => {
          setCreatedKey(data.key);
        },
      },
    );
  };

  const handleCopy = () => {
    if (createdKey) {
      navigator.clipboard.writeText(createdKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // After creation: show the key
  if (createdKey) {
    return (
      <Modal open={open} onClose={handleClose} title={t("apiKeys.created")}>
        <p className="form-hint form-hint-warning">{t("apiKeys.createdWarning")}</p>
        <div className="api-key-display">
          <code className="api-key-value">{createdKey}</code>
          <button onClick={handleCopy}>{copied ? t("btn.copied") : t("btn.copyLink")}</button>
        </div>
        <div className="modal-actions">
          <button className="primary" onClick={handleClose}>
            {t("btn.done")}
          </button>
        </div>
      </Modal>
    );
  }

  // Creation form
  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={t("apiKeys.createTitle")}
      actions={
        <>
          <button type="button" onClick={handleClose}>
            {t("btn.cancel")}
          </button>
          <button
            className="primary"
            type="submit"
            form="create-api-key-form"
            disabled={createMutation.isPending || !name.trim()}
          >
            {createMutation.isPending ? <Spinner /> : t("apiKeys.createBtn")}
          </button>
        </>
      }
    >
      <form id="create-api-key-form" onSubmit={handleSubmit}>
        <div className="form-group">
          <label htmlFor="api-key-name">{t("apiKeys.nameLabel")}</label>
          <input
            id="api-key-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("apiKeys.namePlaceholder")}
            maxLength={100}
            required
            autoFocus
          />
        </div>
        <div className="form-group">
          <label htmlFor="api-key-expires">{t("apiKeys.expiresLabel")}</label>
          <select
            id="api-key-expires"
            value={expiresIn}
            onChange={(e) => setExpiresIn(e.target.value)}
          >
            <option value="30">{t("apiKeys.expires30")}</option>
            <option value="90">{t("apiKeys.expires90")}</option>
            <option value="180">{t("apiKeys.expires180")}</option>
            <option value="365">{t("apiKeys.expires365")}</option>
            <option value="never">{t("apiKeys.expiresNever")}</option>
          </select>
        </div>
        {createMutation.isError && <p className="form-error">{createMutation.error.message}</p>}
      </form>
    </Modal>
  );
}
