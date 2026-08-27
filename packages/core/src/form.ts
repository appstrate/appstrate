// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

// ---------------------------------------------------------------------------
// @appstrate/core/form — AFPS schema wrapper + RJSF adapter
// ---------------------------------------------------------------------------
// AFPS agent manifests carry a wrapper around a pure JSON Schema 2020-12
// document plus three pieces of UI metadata (file constraints, UI hints,
// property order). This module owns the wrapper types, a handful of
// narrow detection helpers, the author-default reader every input
// resolver builds on, and the single transformation that bridges the
// AFPS wrapper to a React JSON Schema Form `<Form>` input shape
// (`schema` + `uiSchema`).
//
// Client-side form rendering is fully delegated to RJSF — this file no
// longer contains field descriptors, form value initializers, or
// hand-rolled validators.
// ---------------------------------------------------------------------------

// ─── JSON Schema Types (from @types/json-schema, draft-07 — compatible with 2020-12) ─

import type { JSONSchema7, JSONSchema7Type, JSONSchema7TypeName } from "json-schema";
import {
  isFileField as isFileFieldShared,
  isMultipleFileField as isMultipleFileFieldShared,
  resolveItems,
  resolveType,
} from "@appstrate/afps-shared/file-field";
export type { JSONSchema7, JSONSchema7Type, JSONSchema7TypeName };

/** A JSON Schema object with typed properties — the root of input/output schemas. */
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
  max_size?: number;
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
  file_constraints?: Record<string, FileConstraint>;
  /** Per-field UI rendering hints, keyed by property name. */
  ui_hints?: Record<string, UIHint>;
  /** Ordered list of property names controlling form field display order. */
  property_order?: string[];
}

// ─── File Field Detection ────────────────────────────────────────────────────

/**
 * Detect a file field: format "uri" + contentMediaType present (single or array).
 * Delegates to the canonical `@appstrate/afps-shared` predicate (single source
 * of truth) — the observable behaviour is unchanged for core consumers.
 */
export function isFileField(prop: JSONSchema7): boolean {
  return isFileFieldShared(prop);
}

/**
 * Detect a multiple-files field (array of file URIs). Delegates to the same
 * canonical predicate as {@link isFileField}, so the two cannot disagree about
 * one node.
 */
export function isMultipleFileField(prop: JSONSchema7): boolean {
  return isMultipleFileFieldShared(prop);
}

/** Whether a schema has any file fields (format: "uri" + contentMediaType). */
export function schemaHasFileFields(schema?: JSONSchemaObject): boolean {
  if (!schema?.properties) return false;
  return Object.values(schema.properties).some(isFileField);
}

// ─── Ordered Keys ────────────────────────────────────────────────────────────

/** Return schema property keys respecting property_order, with unlisted keys appended. */
export function getOrderedKeys(schema: JSONSchemaObject, property_order?: string[]): string[] {
  const allKeys = Object.keys(schema.properties ?? {});
  if (!property_order?.length) return allKeys;
  const ordered = property_order.filter((k) => k in schema.properties);
  const rest = allKeys.filter((k) => !property_order.includes(k));
  return rest.length ? [...ordered, ...rest] : ordered;
}

// ─── Author defaults ─────────────────────────────────────────────────────────

/**
 * Top-level properties of a JSON Schema that declare a `default` keyword,
 * as a plain value map. Properties without a `default` are absent (NOT set to
 * `null`) — an absent property must stay absent so a lower layer, or the
 * schema's own `required` check, sees the truth.
 *
 * This is the author layer of input resolution, and it lives here so the
 * platform and the CLI compute it identically: the same bundle must yield the
 * same parameters whether the run is launched locally or on a platform.
 */
export function authorDefaults(schema: JSONSchemaObject | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(schema?.properties ?? {})) {
    if (prop && typeof prop === "object" && prop.default !== undefined) {
      out[key] = prop.default;
    }
  }
  return out;
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
 *   - `uiSchema`: derived from `file_constraints`, `ui_hints`, `property_order`,
 *     and file-field detection.
 *
 * File fields are marked `ui:widget = "file"`. The widget implementation on
 * the frontend is responsible for uploading the binary via `POST /api/uploads`
 * and writing back a `"upload://upl_xxx"` URI into the form data — this
 * module does not know about the upload protocol.
 */
export function mapAfpsToRjsf(rawWrapper: SchemaWrapper): {
  schema: JSONSchemaObject;
  uiSchema: RjsfUiSchema;
} {
  const wrapper = rawWrapper;
  const fileConstraints = wrapper.file_constraints;
  const uiHints = wrapper.ui_hints;
  const propertyOrder = wrapper.property_order;

  const rawSchema = wrapper.schema;
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
    const constraintMaxSize = constraint?.max_size;
    const items = resolveItems(prop);
    const isArrayOfEnum =
      resolveType(prop) === "array" && Array.isArray(items?.enum) && items.enum.length > 0;
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
      // RJSF widget option name (`maxSize`) is widget-side API and stays
      // camelCase — the snake_case rename only applies to the AFPS manifest.
      if (constraintMaxSize != null) opts.maxSize = constraintMaxSize;
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
