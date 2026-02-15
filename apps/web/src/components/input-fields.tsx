import { FormField } from "./form-field";
import type { JSONSchemaObject } from "@appstrate/shared-types";

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
