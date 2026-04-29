// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

// ---------------------------------------------------------------------------
// @appstrate/core/form — AFPS schema wrapper + RJSF adapter
// ---------------------------------------------------------------------------
// AFPS agent manifests carry a wrapper around a pure JSON Schema 2020-12
// document plus three pieces of UI metadata (file constraints, UI hints,
// property order). This module owns the wrapper types, a handful of
// narrow detection helpers, and the single transformation that bridges
// the AFPS wrapper to a React JSON Schema Form `<Form>` input shape
// (`schema` + `uiSchema`).
//
// Client-side form rendering is fully delegated to RJSF — this file no
// longer contains field descriptors, form value initializers, or
// hand-rolled validators.
// ---------------------------------------------------------------------------

// ─── JSON Schema Types (from @types/json-schema, draft-07 — compatible with 2020-12) ─

import type { JSONSchema7, JSONSchema7Type, JSONSchema7TypeName } from "json-schema";
export type { JSONSchema7, JSONSchema7Type, JSONSchema7TypeName };

/** A JSON Schema object with typed properties — the root of input/config/output schemas. */
export interface JSONSchemaObject {
  type: "object";
  properties: Record<string, JSONSchema7>;
  required?: string[];
}

/**
 * Cast a loosely-typed schema (e.g. from DB / Zod parse) to JSONSchemaObject.
 * Use at system boundaries where the data is known to be a valid JSON Schema
 * object but TypeScript cannot verify it (JSONB columns, dynamic manifests).
 */
export function asJSONSchemaObject(schema: unknown): JSONSchemaObject {
  return schema as JSONSchemaObject;
}

// ─── AFPS Schema Wrapper Types ───────────────────────────────────────────────

/** Constraints for file upload fields defined in AFPS schemas. */
export interface FileConstraint {
  /** Accepted MIME types or file extensions (e.g. "image/*", ".pdf"). */
  accept?: string;
  /** Maximum file size in bytes. */
  maxSize?: number;
}

/** UI rendering hints for form fields. */
export interface UIHint {
  /** Placeholder text to display in the input field. */
  placeholder?: string;
}

/** Wrapper combining a JSON Schema object with AFPS-specific metadata (file constraints, UI hints, ordering). */
export interface SchemaWrapper {
  /** The JSON Schema object defining the form structure. */
  schema: JSONSchemaObject;
  /** Per-field file upload constraints, keyed by property name. */
  fileConstraints?: Record<string, FileConstraint>;
  /** Per-field UI rendering hints, keyed by property name. */
  uiHints?: Record<string, UIHint>;
  /** Ordered list of property names controlling form field display order. */
  propertyOrder?: string[];
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/** Resolve the `type` string from a JSONSchema7 (handles array types by picking the first). */
function getType(prop: JSONSchema7): string | undefined {
  if (typeof prop.type === "string") return prop.type;
  if (Array.isArray(prop.type) && prop.type.length > 0) return prop.type[0];
  return undefined;
}

/** Resolve the `items` schema (handles boolean / tuple forms). */
function getItems(prop: JSONSchema7): JSONSchema7 | undefined {
  if (!prop.items) return undefined;
  if (typeof prop.items === "boolean") return undefined;
  if (Array.isArray(prop.items))
    return typeof prop.items[0] === "object" ? prop.items[0] : undefined;
  return prop.items;
}

// ─── File Field Detection ────────────────────────────────────────────────────

/** Detect a file field: format "uri" + contentMediaType present (single or array). */
export function isFileField(prop: JSONSchema7): boolean {
  if (prop.format === "uri" && prop.contentMediaType) return true;
  const items = getItems(prop);
  if (getType(prop) === "array" && items?.format === "uri" && items?.contentMediaType) return true;
  return false;
}

/** Detect a multiple-files field (array of file URIs). */
export function isMultipleFileField(prop: JSONSchema7): boolean {
  const items = getItems(prop);
  return getType(prop) === "array" && items?.format === "uri" && !!items?.contentMediaType;
}

/** Whether a schema has any file fields (format: "uri" + contentMediaType). */
export function schemaHasFileFields(schema?: JSONSchemaObject): boolean {
  if (!schema?.properties) return false;
  return Object.values(schema.properties).some(isFileField);
}

// ─── Ordered Keys ────────────────────────────────────────────────────────────

/** Return schema property keys respecting propertyOrder, with unlisted keys appended. */
export function getOrderedKeys(schema: JSONSchemaObject, propertyOrder?: string[]): string[] {
  const allKeys = Object.keys(schema.properties ?? {});
  if (!propertyOrder?.length) return allKeys;
  const ordered = propertyOrder.filter((k) => k in schema.properties);
  const rest = allKeys.filter((k) => !propertyOrder.includes(k));
  return rest.length ? [...ordered, ...rest] : ordered;
}

// ─── Backend-side default merging ────────────────────────────────────────────

/** Merge current config with schema defaults. For backend use (no JSON serialization). */
export function mergeWithDefaults(
  schema: JSONSchemaObject,
  current?: Record<string, unknown> | null,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  if (!schema?.properties) return merged;
  for (const [key, prop] of Object.entries(schema.properties)) {
    merged[key] = current?.[key] ?? prop.default ?? null;
  }
  return merged;
}

// ─── AFPS → RJSF adapter ─────────────────────────────────────────────────────

/**
 * Structural shape of the uiSchema consumed by RJSF. We do not depend on
 * `@rjsf/utils` to keep `@appstrate/core` server-friendly. Widget identifiers
 * and options are documented by RJSF — these two keys are enough for the
 * adapter.
 */
export interface RjsfUiSchema {
  /** Order in which top-level properties appear (`"*"` is the wildcard). */
  "ui:order"?: string[];
  [key: string]: string | string[] | number | boolean | RjsfUiSchemaField | undefined;
}

/** Per-property entry inside a uiSchema. */
export interface RjsfUiSchemaField {
  "ui:widget"?: string;
  "ui:placeholder"?: string;
  "ui:help"?: string;
  "ui:options"?: Record<string, unknown>;
  "ui:order"?: string[];
  [key: string]: unknown;
}

/**
 * Map an AFPS `SchemaWrapper` to the two inputs RJSF needs:
 *   - `schema`: pure JSON Schema 2020-12 (passed through as-is).
 *   - `uiSchema`: derived from `fileConstraints`, `uiHints`, `propertyOrder`,
 *     and file-field detection.
 *
 * File fields are marked `ui:widget = "file"`. The widget implementation on
 * the frontend is responsible for uploading the binary via `POST /api/uploads`
 * and writing back a `"upload://upl_xxx"` URI into the form data — this
 * module does not know about the upload protocol.
 */
export function mapAfpsToRjsf(wrapper: SchemaWrapper): {
  schema: JSONSchemaObject;
  uiSchema: RjsfUiSchema;
} {
  const { schema: rawSchema, fileConstraints, uiHints, propertyOrder } = wrapper;
  const uiSchema: RjsfUiSchema = {};
  const properties: Record<string, JSONSchema7> = { ...(rawSchema?.properties ?? {}) };
  const schema: JSONSchemaObject = { ...rawSchema, properties };

  if (propertyOrder?.length && schema?.properties) {
    const order = propertyOrder.filter((k) => k in schema.properties);
    const rest = Object.keys(schema.properties).filter((k) => !propertyOrder.includes(k));
    const full = [...order, ...rest, "*"];
    // RJSF requires "*" to cover unlisted fields; include it defensively.
    uiSchema["ui:order"] = full;
  }

  for (const [key, prop] of Object.entries(schema?.properties ?? {})) {
    const field: RjsfUiSchemaField = {};
    const hint = uiHints?.[key];
    const constraint = fileConstraints?.[key];
    const items = getItems(prop);
    const isArrayOfEnum =
      getType(prop) === "array" && Array.isArray(items?.enum) && items.enum.length > 0;
    const isConst = "const" in prop;

    if (hint?.placeholder) {
      field["ui:placeholder"] = hint.placeholder;
    }

    if (isConst) {
      field["ui:readonly"] = true;
    }

    if (isFileField(prop)) {
      field["ui:widget"] = "file";
      const opts: Record<string, unknown> = {};
      if (isMultipleFileField(prop)) opts.multiple = true;
      if (constraint?.accept) opts.accept = constraint.accept;
      if (constraint?.maxSize != null) opts.maxSize = constraint.maxSize;
      if (prop.maxItems != null) opts.maxFiles = prop.maxItems;
      if (Object.keys(opts).length > 0) field["ui:options"] = opts;
    } else if (isArrayOfEnum) {
      // RJSF's ArrayField renders array-of-enum as repeatable rows (add/remove)
      // unless `uniqueItems: true` is set — in which case it picks the multi-
      // select path. Manifest authors writing `items.enum` almost always mean
      // "pick N distinct values from this set", so we inject the flag here to
      // spare them the footgun. Safe because backend validation runs against
      // the original manifest schema, not this UI-adapted copy.
      if (!prop.uniqueItems) {
        properties[key] = { ...prop, uniqueItems: true };
      }
      field["ui:widget"] = "multiselect";
    } else if (typeof prop.maxLength === "number" && prop.maxLength > 500) {
      field["ui:widget"] = "textarea";
    }

    if (Object.keys(field).length > 0) {
      uiSchema[key] = field;
    }
  }

  return { schema, uiSchema };
}
