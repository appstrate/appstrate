import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "./modal";
import type { JSONSchemaObject } from "@appstrate/shared-types";

interface CustomCredentialsModalProps {
  open: boolean;
  onClose: () => void;
  schema: JSONSchemaObject;
  serviceId: string;
  isPending: boolean;
  onSubmit: (credentials: Record<string, string>) => void;
}

export function CustomCredentialsModal({
  open,
  onClose,
  schema,
  serviceId,
  isPending,
  onSubmit,
}: CustomCredentialsModalProps) {
  const { t } = useTranslation(["settings", "common"]);
  const [values, setValues] = useState<Record<string, string>>({});

  const properties = schema?.properties ?? {};
  const required = schema?.required ?? [];

  const allRequiredFilled = required.every((key) => values[key]?.trim());

  const handleClose = () => {
    setValues({});
    onClose();
  };

  const handleSubmit = () => {
    const credentials: Record<string, string> = {};
    for (const key of Object.keys(properties)) {
      if (values[key]?.trim()) {
        credentials[key] = values[key].trim();
      }
    }
    onSubmit(credentials);
  };

  return (
    <Modal open={open} onClose={handleClose} title={t("customCreds.title", { name: serviceId })}>
      {Object.entries(properties).map(([key, prop]) => {
        const isRequired = required.includes(key);
        return (
          <div key={key} className="form-group">
            <label htmlFor={`cred-${key}`}>
              {prop.description || key}
              {isRequired && " *"}
            </label>
            <input
              id={`cred-${key}`}
              type="password"
              value={values[key] ?? ""}
              onChange={(e) => setValues((prev) => ({ ...prev, [key]: e.target.value }))}
              placeholder={key}
              onKeyDown={(e) => {
                if (e.key === "Enter" && allRequiredFilled && !isPending) handleSubmit();
              }}
            />
          </div>
        );
      })}
      <div className="modal-actions">
        <button onClick={handleClose}>{t("btn.cancel")}</button>
        <button
          className="primary"
          onClick={handleSubmit}
          disabled={!allRequiredFilled || isPending}
        >
          {t("btn.save")}
        </button>
      </div>
    </Modal>
  );
}
