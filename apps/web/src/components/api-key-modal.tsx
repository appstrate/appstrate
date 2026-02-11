import { useState } from "react";
import { Modal } from "./modal";

interface ApiKeyModalProps {
  open: boolean;
  onClose: () => void;
  providerName: string;
  isPending: boolean;
  onSubmit: (apiKey: string) => void;
}

export function ApiKeyModal({ open, onClose, providerName, isPending, onSubmit }: ApiKeyModalProps) {
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
    <Modal open={open} onClose={handleClose} title={`Connexion — ${providerName}`}>
      <div className="form-group">
        <label htmlFor="api-key-input">Cle API</label>
        <input
          id="api-key-input"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={`Cle API ${providerName}`}
          onKeyDown={(e) => {
            if (e.key === "Enter" && apiKey.trim() && !isPending) handleSubmit();
          }}
        />
      </div>
      <div className="modal-actions">
        <button onClick={handleClose}>Annuler</button>
        <button
          className="primary"
          onClick={handleSubmit}
          disabled={!apiKey.trim() || isPending}
        >
          Connecter
        </button>
      </div>
    </Modal>
  );
}
