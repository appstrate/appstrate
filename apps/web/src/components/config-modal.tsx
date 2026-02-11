import { useState } from "react";
import { Modal } from "./modal";
import { FormField } from "./form-field";
import { useSaveConfig } from "../hooks/use-mutations";
import type { FlowDetail } from "@appstrate/shared-types";

interface ConfigModalProps {
  open: boolean;
  onClose: () => void;
  flow: FlowDetail;
}

export function ConfigModal({ open, onClose, flow }: ConfigModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Configuration — ${flow.displayName}`}
      actions={null}
    >
      {open && <ConfigModalForm flow={flow} onClose={onClose} />}
    </Modal>
  );
}

function ConfigModalForm({ flow, onClose }: { flow: FlowDetail; onClose: () => void }) {
  const schema = flow.config?.schema || {};
  const current = flow.config?.current || {};
  const mutation = useSaveConfig(flow.id);

  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const [key, field] of Object.entries(schema)) {
      initial[key] = String(current[key] ?? field.default ?? "");
    }
    return initial;
  });

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
    <>
      {Object.entries(schema).map(([key, field]) => (
        <FormField
          key={key}
          id={`config-${key}`}
          label={key}
          required={field.required}
          type={field.type === "number" ? "number" : "text"}
          value={values[key] || ""}
          onChange={(v) => setValues((prev) => ({ ...prev, [key]: v }))}
          placeholder={field.description}
          description={field.description}
          enumValues={field.enum as string[] | undefined}
        />
      ))}
      <div className="modal-actions">
        <button onClick={onClose}>Annuler</button>
        <button className="primary" onClick={handleSave} disabled={mutation.isPending}>
          Enregistrer
        </button>
      </div>
    </>
  );
}
