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
//
// DELIBERATELY A PARALLEL IMPLEMENTATION of `@appstrate/afps-shared/file-field`,
// not an import of it. Do not "deduplicate" this back into an import — that is
// the change CI rejects.
//
// WHY. `@appstrate/core` is PUBLISHED to npm as source (`src/**` as `.ts`, no
// build step, no `.d.ts` barrier), so a consumer's own `tsc` compiles these
// files against whatever `@appstrate/afps-shared` its install resolves — never
// against the workspace copy. Read the floor from
// `packages/core/package.json` → `dependencies["@appstrate/afps-shared"]`; it
// is `^0.7.0`, and `0.7.0` is the FIRST release to export
// `isMultipleFileField` from `./file-field`. It is not on npm yet (`npm view
// @appstrate/afps-shared versions` tops out at 0.6.0, which exports
// `isFileField` from that subpath and nothing else), so importing it today
// fails a consumer install outright — the same outcome as importing it at the
// previous `^0.6.0` floor, for a different reason. `scripts/verify-package-
// resolves.ts` — CI job "Package resolves for consumers (packages/core)" —
// packs the real artifact into a clean npm project and is what catches it.
//
// The three helpers underneath (`isSingleFileNode`, `resolveItems`,
// `resolveType`) are NOT part of that story: they are private to the shared
// module on purpose — implementation detail of its two predicates, and a name
// exported from a published package is a semver commitment nobody asked for.
// They stay duplicated here whatever the floor says.
//
// WHAT WOULD LET THE TWO PREDICATES MERGE. Publish `afps-shared@0.7.0` (`git
// tag afps-shared@0.7.0`). The floor bump it needs has already been made, so
// that publish is the only remaining step: after it, this block becomes
// `export { isFileField, isMultipleFileField } from
// "@appstrate/afps-shared/file-field"`, with the `JSONSchema7` parameter types
// below re-declared at the call sites that want them.
//
// HOW THE COPIES ARE HELD TOGETHER MEANWHILE. Both sides derive every predicate
// from ONE single-file-node rule, so `isFileField` and `isMultipleFileField`
// cannot disagree about the same array node — the defect this replaced, where
// core's `isMultipleFileField` tested `!!items.contentMediaType` (truthiness)
// while `isFileField` tested "declared", so `contentMediaType: ""` rendered a
// single-file picker bound to an array property. `packages/core/test/
// form.test.ts` pins that input AND asserts table-wide parity against the
// shared module, which the workspace resolves to local source — so a future
// divergence on either side fails a core test at dev time, long before the
// published floor could hide it.

/**
 * Narrow a schema node to an indexable object, or `undefined`.
 *
 * Typed as `unknown`-in on purpose, mirroring the shared module: callers reach
 * `@appstrate/core/form` through `asJSONSchemaObject` casts of JSONB columns and
 * dynamic manifests, so a node can carry values `JSONSchema7` says are
 * impossible. Reading it structurally is what keeps the two rules identical at
 * RUNTIME and not merely where the types happen to agree.
 */
function asNode(schema: unknown): Record<string, unknown> | undefined {
  return schema && typeof schema === "object" ? (schema as Record<string, unknown>) : undefined;
}

/**
 * A single file field: `format: "uri"` + a DECLARED `contentMediaType`.
 *
 * "Declared" is `!= null && !== false`, deliberately NOT truthiness: the
 * keyword's presence is what marks the field as a file, and whether its value is
 * a well-formed media type is the manifest validator's job, not this predicate's.
 * `contentMediaType: ""` is therefore a file field — the reading
 * `apps/api/src/services/inline-run.ts` documents and relies on.
 */
function isSingleFileNode(schema: unknown): boolean {
  const node = asNode(schema);
  if (!node) return false;
  return node.format === "uri" && node.contentMediaType != null && node.contentMediaType !== false;
}

/**
 * Resolve a node's `items` schema, handling the JSON Schema boolean / tuple
 * forms (`items: false` → none; `items: [first, …]` → first object entry).
 */
function resolveItems(schema: unknown): Record<string, unknown> | undefined {
  const node = asNode(schema);
  const items = node?.items;
  if (!items || typeof items === "boolean") return undefined;
  if (Array.isArray(items)) {
    const first = items[0];
    return first && typeof first === "object" ? (first as Record<string, unknown>) : undefined;
  }
  if (typeof items === "object") return items as Record<string, unknown>;
  return undefined;
}

/** Resolve a node's `type` (JSON Schema allows a union array — first wins). */
function resolveType(schema: unknown): string | undefined {
  const node = asNode(schema);
  if (!node) return undefined;
  if (typeof node.type === "string") return node.type;
  if (Array.isArray(node.type) && node.type.length > 0 && typeof node.type[0] === "string") {
    return node.type[0];
  }
  return undefined;
}

/**
 * Detect an AFPS file field: a single string-URI node with `contentMediaType`,
 * OR an array whose items are such a node.
 */
export function isFileField(prop: JSONSchema7): boolean {
  return isSingleFileNode(prop) || isMultipleFileField(prop);
}

/**
 * Detect a MULTIPLE-files field: an array whose `items` are a single file node.
 *
 * Shares {@link isSingleFileNode} with {@link isFileField} by construction, so
 * the two can never disagree about the same array node.
 */
export function isMultipleFileField(prop: JSONSchema7): boolean {
  return resolveType(prop) === "array" && isSingleFileNode(resolveItems(prop));
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
