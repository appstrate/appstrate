// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

// ---------------------------------------------------------------------------
// @appstrate/core/form — Pure JSON Schema form utilities
// ---------------------------------------------------------------------------
// Transforms JSON Schema (as used in AFPS flow manifests) into form field
// descriptors, initializes values, builds typed payloads, and validates
// client-side. No React, no DOM — pure functions only.
// ---------------------------------------------------------------------------

// ─── JSON Schema Types (from @types/json-schema, draft-07) ───────────────────

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

// ─── Field Descriptor ────────────────────────────────────────────────────────

/** Supported form field types derived from JSON Schema property definitions. */
export type FieldType =
  | "text"
  | "textarea"
  | "number"
  | "boolean"
  | "enum"
  | "json"
  | "file"
  | "file-multiple";

/** Validation constraints extracted from JSON Schema property definitions. */
export interface FieldValidation {
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
}

/** Descriptor for a single form field, derived from a JSON Schema property. */
export interface FieldDescriptor {
  /** Property key in the schema. */
  key: string;
  /** Resolved field type for UI rendering. */
  type: FieldType;
  /** Display label (defaults to the property key). */
  label: string;
  /** Whether the field is required by the schema. */
  required: boolean;
  /** Description text from the schema property. */
  description?: string;
  /** Placeholder text from UI hints or schema description. */
  placeholder?: string;
  /** Default value from the schema. */
  defaultValue?: unknown;
  /** Allowed values for enum fields. */
  enumValues?: string[];
  /** File upload constraints for file/file-multiple fields. */
  fileConstraints?: FileConstraint & { maxFiles?: number };
  /** Validation constraints extracted from the schema. */
  validation?: FieldValidation;
}

// ─── Field Error ─────────────────────────────────────────────────────────────

/** A validation error for a specific form field. */
export interface FieldError {
  /** Property key that failed validation. */
  key: string;
  /** Machine-readable error code: "required" | "type" | "enum" | "minimum" | "maximum" | "minLength" | "maxLength" | "pattern". */
  message: string;
  /** Additional context for the error (e.g. expected type, min/max values). */
  params?: Record<string, unknown>;
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/** Extract the list of required field names from a JSON Schema object. */
function getRequired(schema: JSONSchemaObject): string[] {
  return schema.required ?? [];
}

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

// ─── Ordered Keys ────────────────────────────────────────────────────────────

/** Return schema property keys respecting propertyOrder, with unlisted keys appended. */
export function getOrderedKeys(schema: JSONSchemaObject, propertyOrder?: string[]): string[] {
  const allKeys = Object.keys(schema.properties ?? {});
  if (!propertyOrder?.length) return allKeys;
  const ordered = propertyOrder.filter((k) => k in schema.properties);
  const rest = allKeys.filter((k) => !propertyOrder.includes(k));
  return rest.length ? [...ordered, ...rest] : ordered;
}

// ─── Schema → Field Descriptors ──────────────────────────────────────────────

function resolveFieldType(prop: JSONSchema7): FieldType {
  if (isMultipleFileField(prop)) return "file-multiple";
  if (isFileField(prop)) return "file";
  if (prop.enum && prop.enum.length > 0) return "enum";
  const t = getType(prop);
  if (t === "object") return "json";
  if (t === "array") return "json";
  if (t === "boolean") return "boolean";
  if (t === "number" || t === "integer") return "number";
  if (t === "string" && prop.maxLength && prop.maxLength > 500) return "textarea";
  return "text";
}

function extractValidation(prop: JSONSchema7): FieldValidation | undefined {
  const v: FieldValidation = {};
  let hasAny = false;
  if (prop.minLength != null) {
    v.minLength = prop.minLength;
    hasAny = true;
  }
  if (prop.maxLength != null) {
    v.maxLength = prop.maxLength;
    hasAny = true;
  }
  if (prop.minimum != null) {
    v.minimum = prop.minimum;
    hasAny = true;
  }
  if (prop.maximum != null) {
    v.maximum = prop.maximum;
    hasAny = true;
  }
  if (prop.pattern != null) {
    v.pattern = prop.pattern;
    hasAny = true;
  }
  return hasAny ? v : undefined;
}

/** Convert a SchemaWrapper into an ordered list of FieldDescriptors. */
export function schemaToFields(wrapper: SchemaWrapper): FieldDescriptor[] {
  const { schema, fileConstraints, uiHints, propertyOrder } = wrapper;
  if (!schema?.properties) return [];

  const keys = getOrderedKeys(schema, propertyOrder);
  const required = getRequired(schema);

  return keys.map((key) => {
    const prop = schema.properties[key]!;
    const fieldType = resolveFieldType(prop);
    const hint = uiHints?.[key];
    const fc = fileConstraints?.[key];

    const descriptor: FieldDescriptor = {
      key,
      type: fieldType,
      label: key,
      required: required.includes(key),
      description: prop.description,
      placeholder: hint?.placeholder ?? prop.description,
      defaultValue: prop.default,
    };

    if (fieldType === "enum" && prop.enum) {
      descriptor.enumValues = prop.enum.map(String);
    }

    if (fieldType === "file" || fieldType === "file-multiple") {
      descriptor.fileConstraints = {
        ...fc,
        maxFiles: prop.maxItems,
      };
    }

    const validation = extractValidation(prop);
    if (validation) {
      descriptor.validation = validation;
    }

    return descriptor;
  });
}

// ─── Form Value Initialization ───────────────────────────────────────────────

/** Initialize form values from schema defaults and optional existing data. File fields are excluded. */
export function initFormValues(
  schema: JSONSchemaObject,
  existing?: Record<string, unknown> | null,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  if (!schema?.properties) return values;

  for (const [key, prop] of Object.entries(schema.properties)) {
    if (isFileField(prop)) continue;

    const t = getType(prop);
    const isJsonType = t === "object" || t === "array";

    if (existing != null && key in existing && existing[key] != null) {
      values[key] =
        isJsonType && typeof existing[key] === "object"
          ? JSON.stringify(existing[key], null, 2)
          : existing[key];
    } else if (prop.default !== undefined) {
      values[key] =
        isJsonType && typeof prop.default === "object"
          ? JSON.stringify(prop.default, null, 2)
          : prop.default;
    } else {
      values[key] = isJsonType ? (t === "array" ? "[]" : "{}") : "";
    }
  }
  return values;
}

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

// ─── Build Typed Payload ─────────────────────────────────────────────────────

/** Convert raw form values to a typed payload suitable for API submission. */
export function buildPayload(
  schema: JSONSchemaObject,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (!schema?.properties) return payload;

  for (const [key, prop] of Object.entries(schema.properties)) {
    if (isFileField(prop)) continue;

    const raw = values[key];
    const t = getType(prop);

    // Empty string → null
    if (raw === "" || raw === undefined) {
      payload[key] = null;
      continue;
    }

    // JSON string coercion for object/array types
    if ((t === "object" || t === "array") && typeof raw === "string") {
      try {
        payload[key] = JSON.parse(raw);
      } catch {
        payload[key] = raw;
      }
      continue;
    }

    // Number coercion
    if ((t === "number" || t === "integer") && typeof raw === "string") {
      payload[key] = Number(raw);
      continue;
    }

    // Boolean coercion from string
    if (t === "boolean" && typeof raw === "string") {
      payload[key] = raw === "true";
      continue;
    }

    payload[key] = raw;
  }
  return payload;
}

// ─── Client-Side Validation ──────────────────────────────────────────────────

/** Validate form values against the JSON Schema. Returns an array of errors (empty = valid). */
export function validateFormValues(
  schema: JSONSchemaObject,
  values: Record<string, unknown>,
): FieldError[] {
  const errors: FieldError[] = [];
  if (!schema?.properties) return errors;

  const required = getRequired(schema);

  for (const [key, prop] of Object.entries(schema.properties)) {
    if (isFileField(prop)) continue;

    const raw = values[key];

    // Required check — 0 and false are valid values
    if (required.includes(key)) {
      if (raw === undefined || raw === null || raw === "") {
        errors.push({ key, message: "required" });
        continue; // Skip further validation for missing required fields
      }
    }

    // Skip validation for empty optional fields
    if (raw === undefined || raw === null || raw === "") continue;

    // Type check
    const expectedType = getType(prop);
    if (expectedType === "number" || expectedType === "integer") {
      const num = typeof raw === "string" ? Number(raw) : raw;
      if (typeof num !== "number" || Number.isNaN(num)) {
        errors.push({ key, message: "type", params: { expected: "number" } });
        continue;
      }

      // Min/max for numbers
      if (prop.minimum != null && num < prop.minimum) {
        errors.push({ key, message: "minimum", params: { minimum: prop.minimum, actual: num } });
      }
      if (prop.maximum != null && num > prop.maximum) {
        errors.push({ key, message: "maximum", params: { maximum: prop.maximum, actual: num } });
      }
    } else if (expectedType === "boolean") {
      if (typeof raw !== "boolean" && raw !== "true" && raw !== "false") {
        errors.push({ key, message: "type", params: { expected: "boolean" } });
        continue;
      }
    } else if (expectedType === "object" || expectedType === "array") {
      // Validate JSON string is parseable
      if (typeof raw === "string") {
        try {
          const parsed = JSON.parse(raw);
          if (expectedType === "object" && (typeof parsed !== "object" || Array.isArray(parsed))) {
            errors.push({ key, message: "type", params: { expected: "object" } });
          }
          if (expectedType === "array" && !Array.isArray(parsed)) {
            errors.push({ key, message: "type", params: { expected: "array" } });
          }
        } catch {
          errors.push({ key, message: "type", params: { expected: expectedType } });
        }
      }
    } else if (expectedType === "string" || !expectedType) {
      const str = String(raw);

      if (prop.minLength != null && str.length < prop.minLength) {
        errors.push({
          key,
          message: "minLength",
          params: { minLength: prop.minLength, actual: str.length },
        });
      }
      if (prop.maxLength != null && str.length > prop.maxLength) {
        errors.push({
          key,
          message: "maxLength",
          params: { maxLength: prop.maxLength, actual: str.length },
        });
      }
      if (prop.pattern) {
        try {
          if (!new RegExp(prop.pattern).test(str)) {
            errors.push({ key, message: "pattern", params: { pattern: prop.pattern } });
          }
        } catch {
          // Invalid regex in schema — skip pattern validation
        }
      }
    }

    // Enum check (applies to any type)
    if (prop.enum && prop.enum.length > 0) {
      const stringValues = prop.enum.map(String);
      if (!stringValues.includes(String(raw))) {
        errors.push({ key, message: "enum", params: { allowed: prop.enum } });
      }
    }
  }

  return errors;
}
