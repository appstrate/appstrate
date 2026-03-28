import { FormField } from "./form-field";
import { FileField } from "./file-field";
import type { JSONSchemaObject, FileConstraint, UIHint } from "@appstrate/shared-types";
import { isFileField, isMultipleFileField } from "@appstrate/shared-types";

interface InputFieldsProps {
  schema: JSONSchemaObject;
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  fileValues?: Record<string, File[]>;
  onFileChange?: (key: string, files: File[]) => void;
  idPrefix?: string;
  errors?: Record<string, string>;
  fileConstraints?: Record<string, FileConstraint>;
  uiHints?: Record<string, UIHint>;
}

export function InputFields({
  schema,
  values,
  onChange,
  fileValues,
  onFileChange,
  idPrefix = "input",
  errors,
  fileConstraints,
  uiHints,
}: InputFieldsProps) {
  return (
    <>
      {schema?.properties &&
        Object.entries(schema.properties).map(([key, prop]) => {
          if (isFileField(prop)) {
            const constraints = fileConstraints?.[key];
            const multiple = isMultipleFileField(prop);
            const maxFiles = prop.maxItems;
            return (
              <FileField
                key={key}
                label={key}
                required={schema.required?.includes(key)}
                accept={constraints?.accept}
                maxSize={constraints?.maxSize}
                multiple={multiple}
                maxFiles={maxFiles}
                files={fileValues?.[key] ?? []}
                onChange={(files) => onFileChange?.(key, files)}
                description={prop.description}
              />
            );
          }
          const placeholder = uiHints?.[key]?.placeholder || prop.description;
          return (
            <FormField
              key={key}
              id={`${idPrefix}-${key}`}
              label={key}
              required={schema.required?.includes(key)}
              type={prop.type === "number" ? "number" : "text"}
              value={values[key] || ""}
              onChange={(v) => onChange(key, v)}
              placeholder={placeholder}
              description={prop.description}
              error={errors?.[key]}
            />
          );
        })}
    </>
  );
}
