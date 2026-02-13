import { FormField } from "./form-field";
import type { FlowInputField } from "@appstrate/shared-types";

export function initInputValues(
  schema: Record<string, FlowInputField>,
  existing?: Record<string, unknown> | null,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, field] of Object.entries(schema)) {
    values[key] = String(existing?.[key] ?? field.default ?? "");
  }
  return values;
}

export function buildInputPayload(
  schema: Record<string, FlowInputField>,
  values: Record<string, string>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema)) {
    let value: unknown = values[key];
    if (field.type === "number" && value) value = Number(value);
    payload[key] = value || null;
  }
  return payload;
}

interface InputFieldsProps {
  schema: Record<string, FlowInputField>;
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  idPrefix?: string;
}

export function InputFields({ schema, values, onChange, idPrefix = "input" }: InputFieldsProps) {
  return (
    <>
      {Object.entries(schema).map(([key, field]) => (
        <FormField
          key={key}
          id={`${idPrefix}-${key}`}
          label={key}
          required={field.required}
          type={field.type === "number" ? "number" : "text"}
          value={values[key] || ""}
          onChange={(v) => onChange(key, v)}
          placeholder={field.placeholder || field.description}
          description={field.description}
        />
      ))}
    </>
  );
}
