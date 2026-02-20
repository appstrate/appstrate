import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "./modal";
import { InputFields } from "./input-fields";
import { Spinner } from "./spinner";
import { initInputValues, buildInputPayload } from "./input-utils";
import type { FlowDetail } from "@appstrate/shared-types";

interface InputModalProps {
  open: boolean;
  onClose: () => void;
  flow: FlowDetail;
  onSubmit: (input: Record<string, unknown>, files?: Record<string, File[]>) => void;
  isPending?: boolean;
  initialValues?: Record<string, unknown>;
}

export function InputModal({
  open,
  onClose,
  flow,
  onSubmit,
  isPending,
  initialValues,
}: InputModalProps) {
  const { t } = useTranslation(["flows", "common"]);

  const guardedClose = () => {
    if (!isPending) onClose();
  };

  return (
    <Modal
      open={open}
      onClose={guardedClose}
      title={t("input.title", { name: flow.displayName })}
      actions={null}
    >
      {open && (
        <InputModalForm
          flow={flow}
          onClose={guardedClose}
          onSubmit={onSubmit}
          isPending={isPending}
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
  isPending,
  initialValues,
}: {
  flow: FlowDetail;
  onClose: () => void;
  onSubmit: (input: Record<string, unknown>, files?: Record<string, File[]>) => void;
  isPending?: boolean;
  initialValues?: Record<string, unknown>;
}) {
  const { t } = useTranslation(["flows", "common"]);
  const schema = flow.input?.schema || { type: "object" as const, properties: {} };

  const [values, setValues] = useState<Record<string, string>>(() =>
    initInputValues(schema, initialValues),
  );
  const [fileValues, setFileValues] = useState<Record<string, File[]>>({});

  const handleSubmit = () => {
    const input = buildInputPayload(schema, values);

    // Validate required text fields
    for (const key of Object.keys(schema.properties)) {
      const prop = schema.properties[key]!;
      if (prop.type === "file") continue;
      if (schema.required?.includes(key) && (!input[key] || input[key] === "")) {
        alert(t("input.fieldRequired", { field: key }));
        return;
      }
    }

    // Validate required file fields
    for (const key of Object.keys(schema.properties)) {
      const prop = schema.properties[key]!;
      if (prop.type !== "file") continue;
      if (schema.required?.includes(key) && (!fileValues[key] || fileValues[key]!.length === 0)) {
        alert(t("input.fileRequired", { field: key }));
        return;
      }
    }

    // Check if we have any files
    const hasFiles = Object.values(fileValues).some((f) => f.length > 0);
    onSubmit(input, hasFiles ? fileValues : undefined);
  };

  return (
    <>
      <InputFields
        schema={schema}
        values={values}
        onChange={(key, v) => setValues((prev) => ({ ...prev, [key]: v }))}
        fileValues={fileValues}
        onFileChange={(key, files) => setFileValues((prev) => ({ ...prev, [key]: files }))}
      />
      <div className="modal-actions">
        <button onClick={onClose} disabled={isPending}>
          {t("btn.cancel")}
        </button>
        <button className="primary" onClick={handleSubmit} disabled={isPending}>
          {isPending ? <Spinner /> : t("input.run")}
        </button>
      </div>
    </>
  );
}
