import { useState, useEffect } from "react";
import { Modal } from "./modal";
import { useSaveConfig } from "../hooks/use-mutations";
import type { FlowDetail } from "../types";

interface ConfigModalProps {
  open: boolean;
  onClose: () => void;
  flow: FlowDetail;
}

export function ConfigModal({ open, onClose, flow }: ConfigModalProps) {
  const schema = flow.config?.schema || {};
  const current = flow.config?.current || {};
  const mutation = useSaveConfig(flow.id);

  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    if (open) {
      const initial: Record<string, string> = {};
      for (const [key, field] of Object.entries(schema)) {
        initial[key] = String(current[key] ?? field.default ?? "");
      }
      setValues(initial);
    }
  }, [open, schema, current]);

  const handleSave = () => {
    const config: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(schema)) {
      let value: unknown = values[key];
      if (field.type === "number" && value) value = Number(value);
      config[key] = value || null;
    }
    mutation.mutate(config, { onSuccess: onClose });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Configuration — ${flow.displayName}`}
      actions={
        <>
          <button onClick={onClose}>Annuler</button>
          <button className="primary" onClick={handleSave} disabled={mutation.isPending}>
            Enregistrer
          </button>
        </>
      }
    >
      {Object.entries(schema).map(([key, field]) => (
        <div className="form-group" key={key}>
          <label htmlFor={`config-${key}`}>{key}{field.required ? " *" : ""}</label>
          {field.enum ? (
            <select
              id={`config-${key}`}
              value={values[key] || ""}
              onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
            >
              {(field.enum as string[]).map((opt) => (
                <option key={opt} value={opt}>{opt}</option>
              ))}
            </select>
          ) : (
            <input
              id={`config-${key}`}
              type={field.type === "number" ? "number" : "text"}
              value={values[key] || ""}
              onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
              placeholder={field.description}
            />
          )}
          <div className="hint">{field.description}</div>
        </div>
      ))}
    </Modal>
  );
}
