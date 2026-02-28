import { FormField } from "./form-field";
import { FileField } from "./file-field";
import type { JSONSchemaObject } from "@appstrate/shared-types";

interface InputFieldsProps {
  schema: JSONSchemaObject;
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  fileValues?: Record<string, File[]>;
  onFileChange?: (key: string, files: File[]) => void;
  idPrefix?: string;
  errors?: Record<string, string>;
}

export function InputFields({
  schema,
  values,
  onChange,
  fileValues,
  onFileChange,
  idPrefix = "input",
  errors,
}: InputFieldsProps) {
  return (
    <>
      {schema?.properties &&
        Object.entries(schema.properties).map(([key, prop]) => {
          if (prop.type === "file") {
            return (
              <FileField
                key={key}
                label={key}
                required={schema.required?.includes(key)}
                accept={prop.accept}
                maxSize={prop.maxSize}
                multiple={prop.multiple}
                maxFiles={prop.maxFiles}
                files={fileValues?.[key] ?? []}
                onChange={(files) => onFileChange?.(key, files)}
                description={prop.description}
              />
            );
          }
          return (
            <FormField
              key={key}
              id={`${idPrefix}-${key}`}
              label={key}
              required={schema.required?.includes(key)}
              type={prop.type === "number" ? "number" : "text"}
              value={values[key] || ""}
              onChange={(v) => onChange(key, v)}
              placeholder={prop.placeholder || prop.description}
              description={prop.description}
              error={errors?.[key]}
            />
          );
        })}
    </>
  );
}
