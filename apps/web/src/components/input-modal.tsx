import { useTranslation } from "react-i18next";
import { useForm, useWatch } from "react-hook-form";
import { Modal } from "./modal";
import { Button } from "@/components/ui/button";
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

type InputFormData = {
  values: Record<string, string>;
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
  const schema = flow.input?.schema || { type: "object" as const, properties: {} };

  const {
    setValue,
    setError,
    clearErrors,
    control,
    formState: { errors },
  } = useForm<InputFormData>({
    defaultValues: {
      values: initInputValues(schema, initialValues),
      fileValues: {},
    },
  });

  const values = useWatch({ control, name: "values" });
  const fileValues = useWatch({ control, name: "fileValues" });

  const handleFieldChange = (key: string, v: string) => {
    setValue("values", { ...values, [key]: v });
    clearErrors("root");
  };

  const handleFileChange = (key: string, files: File[]) => {
    setValue("fileValues", { ...fileValues, [key]: files });
    clearErrors("root");
  };

  const computeFieldErrors = (): Record<string, string> => {
    const input = buildInputPayload(schema, values);
    const fieldErrs: Record<string, string> = {};
    for (const key of Object.keys(schema.properties)) {
      const prop = schema.properties[key]!;
      if (prop.type === "file") {
        if (schema.required?.includes(key) && (!fileValues[key] || fileValues[key]!.length === 0)) {
          fieldErrs[key] = t("input.fileRequired", { field: key });
        }
      } else {
        if (schema.required?.includes(key) && (!input[key] || input[key] === "")) {
          fieldErrs[key] = t("input.fieldRequired", { field: key });
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
    const input = buildInputPayload(schema, values);
    const hasFiles = Object.values(fileValues).some((f) => f.length > 0);
    onSubmit(input, hasFiles ? fileValues : undefined);
  };

  const fieldErrors = errors.root ? computeFieldErrors() : {};

  return (
    <>
      <InputFields
        schema={schema}
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
