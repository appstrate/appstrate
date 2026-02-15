import { FormField } from "./form-field";
import type { JSONSchemaObject } from "@appstrate/shared-types";

export function initInputValues(
  schema: JSONSchemaObject,
  existing?: Record<string, unknown> | null,
): Record<string, string> {
  const values: Record<string, string> = {};
  if (schema?.properties) {
    for (const [key, prop] of Object.entries(schema.properties)) {
      values[key] = String(existing?.[key] ?? prop.default ?? "");
    }
  }
  return values;
}

export function buildInputPayload(
  schema: JSONSchemaObject,
  values: Record<string, string>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (schema?.properties) {
    for (const [key, prop] of Object.entries(schema.properties)) {
      let value: unknown = values[key];
      if (prop.type === "number" && value) value = Number(value);
      payload[key] = value || null;
    }
  }
  return payload;
}

interface InputFieldsProps {
  schema: JSONSchemaObject;
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  idPrefix?: string;
}

export function InputFields({ schema, values, onChange, idPrefix = "input" }: InputFieldsProps) {
  return (
    <>
      {schema?.properties &&
        Object.entries(schema.properties).map(([key, prop]) => (
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
          />
        ))}
    </>
  );
}
