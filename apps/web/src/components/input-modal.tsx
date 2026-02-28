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
  const [errors, setErrors] = useState<Record<string, string>>({});

  const clearFieldError = (key: string) => {
    setErrors((prev) => {
      if (!prev[key]) return prev;
      const { [key]: _, ...rest } = prev;
      return rest;
    });
  };

  const handleSubmit = () => {
    const input = buildInputPayload(schema, values);
    const newErrors: Record<string, string> = {};

    // Validate required text fields
    for (const key of Object.keys(schema.properties)) {
      const prop = schema.properties[key]!;
      if (prop.type === "file") continue;
      if (schema.required?.includes(key) && (!input[key] || input[key] === "")) {
        newErrors[key] = t("input.fieldRequired", { field: key });
      }
    }

    // Validate required file fields
    for (const key of Object.keys(schema.properties)) {
      const prop = schema.properties[key]!;
      if (prop.type !== "file") continue;
      if (schema.required?.includes(key) && (!fileValues[key] || fileValues[key]!.length === 0)) {
        newErrors[key] = t("input.fileRequired", { field: key });
      }
    }

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
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
        onChange={(key, v) => {
          setValues((prev) => ({ ...prev, [key]: v }));
          clearFieldError(key);
        }}
        fileValues={fileValues}
        onFileChange={(key, files) => {
          setFileValues((prev) => ({ ...prev, [key]: files }));
          clearFieldError(key);
        }}
        errors={errors}
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
