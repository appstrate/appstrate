import { useState } from "react";
import { Modal } from "./modal";
import { FormField } from "./form-field";
import type { FlowDetail } from "@appstrate/shared-types";

interface InputModalProps {
  open: boolean;
  onClose: () => void;
  flow: FlowDetail;
  onSubmit: (input: Record<string, unknown>) => void;
  initialValues?: Record<string, unknown>;
}

export function InputModal({ open, onClose, flow, onSubmit, initialValues }: InputModalProps) {
  return (
    <Modal open={open} onClose={onClose} title={`${flow.displayName} — Parametres`} actions={null}>
      {open && (
        <InputModalForm
          flow={flow}
          onClose={onClose}
          onSubmit={onSubmit}
          initialValues={initialValues}
        />
      )}
    </Modal>
  );
}

function InputModalForm({
  flow,
  onClose,
  onSubmit,
  initialValues,
}: {
  flow: FlowDetail;
  onClose: () => void;
  onSubmit: (input: Record<string, unknown>) => void;
  initialValues?: Record<string, unknown>;
}) {
  const schema = flow.input?.schema || {};

  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const [key, field] of Object.entries(schema)) {
      initial[key] = String(initialValues?.[key] ?? field.default ?? "");
    }
    return initial;
  });

  const handleSubmit = () => {
    const input: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(schema)) {
      let value: unknown = values[key];
      if (field.type === "number" && value) value = Number(value);
      input[key] = value || null;
    }

    for (const [key, field] of Object.entries(schema)) {
      if (field.required && (!input[key] || input[key] === "")) {
        alert(`Le champ "${key}" est requis`);
        return;
      }
    }

    onSubmit(input);
    onClose();
  };

  return (
    <>
      {Object.entries(schema).map(([key, field]) => (
        <FormField
          key={key}
          id={`input-${key}`}
          label={key}
          required={field.required}
          type={field.type === "number" ? "number" : "text"}
          value={values[key] || ""}
          onChange={(v) => setValues((prev) => ({ ...prev, [key]: v }))}
          placeholder={field.placeholder || field.description}
          description={field.description}
        />
      ))}
      <div className="modal-actions">
        <button onClick={onClose}>Annuler</button>
        <button className="primary" onClick={handleSubmit}>
          Lancer
        </button>
      </div>
    </>
  );
}
