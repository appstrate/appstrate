import { useState, useEffect } from "react";
import { Modal } from "./modal";
import type { FlowDetail } from "../types";

interface InputModalProps {
  open: boolean;
  onClose: () => void;
  flow: FlowDetail;
  onSubmit: (input: Record<string, unknown>) => void;
}

export function InputModal({ open, onClose, flow, onSubmit }: InputModalProps) {
  const schema = flow.input?.schema || {};
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    if (open) {
      const initial: Record<string, string> = {};
      for (const [key, field] of Object.entries(schema)) {
        initial[key] = String(field.default ?? "");
      }
      setValues(initial);
    }
  }, [open, schema]);

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
    <Modal
      open={open}
      onClose={onClose}
      title={`${flow.displayName} — Parametres`}
      actions={
        <>
          <button onClick={onClose}>Annuler</button>
          <button className="primary" onClick={handleSubmit}>Lancer</button>
        </>
      }
    >
      {Object.entries(schema).map(([key, field]) => (
        <div className="form-group" key={key}>
          <label htmlFor={`input-${key}`}>{key}{field.required ? " *" : ""}</label>
          <input
            id={`input-${key}`}
            type={field.type === "number" ? "number" : "text"}
            value={values[key] || ""}
            onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
            placeholder={field.placeholder || field.description}
          />
          <div className="hint">{field.description}</div>
        </div>
      ))}
    </Modal>
  );
}
