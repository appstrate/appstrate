import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "./modal";
import { getOrderedKeys, type JSONSchemaObject } from "@appstrate/shared-types";

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
  const [visibleFields, setVisibleFields] = useState<Record<string, boolean>>({});

  const properties = schema?.properties ?? {};
  const required = schema?.required ?? [];

  const orderedKeys = getOrderedKeys(schema);
  const allRequiredFilled = required.every((key) => values[key]?.trim());

  const toggleVisibility = (key: string) => {
    setVisibleFields((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleClose = () => {
    setValues({});
    setVisibleFields({});
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
      {orderedKeys.map((key) => {
        const prop = properties[key];
        const isRequired = required.includes(key);
        const isVisible = visibleFields[key] ?? false;
        return (
          <div key={key} className="form-group">
            <label htmlFor={`cred-${key}`}>
              {prop.description || key}
              {isRequired && " *"}
            </label>
            <div className="input-with-toggle">
              <input
                id={`cred-${key}`}
                type={isVisible ? "text" : "password"}
                value={values[key] ?? ""}
                onChange={(e) => setValues((prev) => ({ ...prev, [key]: e.target.value }))}
                placeholder={key}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && allRequiredFilled && !isPending) handleSubmit();
                }}
              />
              <button
                type="button"
                className="input-toggle-btn"
                onClick={() => toggleVisibility(key)}
                tabIndex={-1}
              >
                {isVisible ? "◡" : "⦿"}
              </button>
            </div>
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
