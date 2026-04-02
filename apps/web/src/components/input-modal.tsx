// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { useForm, useWatch } from "react-hook-form";
import { Modal } from "./modal";
import { Button } from "@/components/ui/button";
import { InputFields } from "./input-fields";
import { Spinner } from "./spinner";
import {
  initFormValues,
  buildPayload,
  validateFormValues,
  isFileField,
  type SchemaWrapper,
  type JSONSchemaObject,
} from "@appstrate/core/form";
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

const EMPTY_SCHEMA: JSONSchemaObject = { type: "object", properties: {} };

type InputFormData = {
  values: Record<string, unknown>;
  fileValues: Record<string, File[]>;
};

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
  const wrapper: SchemaWrapper = flow.input ?? { schema: EMPTY_SCHEMA };
  const schema = wrapper.schema;

  const {
    setValue,
    setError,
    clearErrors,
    control,
    formState: { errors },
  } = useForm<InputFormData>({
    defaultValues: {
      values: initFormValues(schema, initialValues),
      fileValues: {},
    },
  });

  const values = useWatch({ control, name: "values" });
  const fileValues = useWatch({ control, name: "fileValues" });

  const handleFieldChange = (key: string, v: unknown) => {
    setValue("values", { ...values, [key]: v });
    clearErrors("root");
  };

  const handleFileChange = (key: string, files: File[]) => {
    setValue("fileValues", { ...fileValues, [key]: files });
    clearErrors("root");
  };

  const computeFieldErrors = (): Record<string, string> => {
    const fieldErrs: Record<string, string> = {};

    // Validate non-file fields via core
    const coreErrors = validateFormValues(schema, values);
    for (const err of coreErrors) {
      fieldErrs[err.key] = t(`input.${err.message}`, {
        field: err.key,
        ...err.params,
        defaultValue: t("input.fieldRequired", { field: err.key }),
      });
    }

    // Validate required file fields (File API not available in core)
    for (const [key, prop] of Object.entries(schema.properties)) {
      if (isFileField(prop) && schema.required?.includes(key)) {
        if (!fileValues[key] || fileValues[key]!.length === 0) {
          fieldErrs[key] = t("input.fileRequired", { field: key });
        }
      }
    }

    return fieldErrs;
  };

  const handleFormSubmit = () => {
    const fieldErrs = computeFieldErrors();
    if (Object.keys(fieldErrs).length > 0) {
      setError("root", { message: "validation" });
      return;
    }
    const input = buildPayload(schema, values);
    const hasFiles = Object.values(fileValues).some((f) => f.length > 0);
    onSubmit(input, hasFiles ? fileValues : undefined);
  };

  const fieldErrors = errors.root ? computeFieldErrors() : {};

  return (
    <>
      <InputFields
        schema={wrapper}
        values={values}
        onChange={handleFieldChange}
        fileValues={fileValues}
        onFileChange={handleFileChange}
        errors={fieldErrors}
      />
      <div className="flex justify-end gap-2 pt-4">
        <Button variant="outline" onClick={onClose} disabled={isPending}>
          {t("btn.cancel")}
        </Button>
        <Button onClick={handleFormSubmit} disabled={isPending}>
          {isPending ? <Spinner /> : t("input.run")}
        </Button>
      </div>
    </>
  );
}
