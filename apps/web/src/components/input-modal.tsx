import { useState } from "react";
import { Modal } from "./modal";
import { InputFields, initInputValues, buildInputPayload } from "./input-fields";
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

  const [values, setValues] = useState<Record<string, string>>(() =>
    initInputValues(schema, initialValues),
  );

  const handleSubmit = () => {
    const input = buildInputPayload(schema, values);

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
      <InputFields
        schema={schema}
        values={values}
        onChange={(key, v) => setValues((prev) => ({ ...prev, [key]: v }))}
      />
      <div className="modal-actions">
        <button onClick={onClose}>Annuler</button>
        <button className="primary" onClick={handleSubmit}>
          Lancer
        </button>
      </div>
    </>
  );
}
