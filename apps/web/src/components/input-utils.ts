import type { JSONSchemaObject } from "@appstrate/shared-types";
import { isFileField } from "@appstrate/shared-types";

export function initInputValues(
  schema: JSONSchemaObject,
  existing?: Record<string, unknown> | null,
): Record<string, string> {
  const values: Record<string, string> = {};
  if (schema?.properties) {
    for (const [key, prop] of Object.entries(schema.properties)) {
      if (isFileField(prop)) continue;
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
      if (isFileField(prop)) continue;
      let value: unknown = values[key];
      if (prop.type === "number" && value) value = Number(value);
      payload[key] = value || null;
    }
  }
  return payload;
}
