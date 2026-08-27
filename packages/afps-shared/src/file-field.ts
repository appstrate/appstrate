// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical AFPS file-field predicate — the SINGLE source of truth shared by
 * `@appstrate/core/form` (apps/web SchemaForm, apps/api) and
 * `@appstrate/afps-runtime`'s platform-prompt composer.
 *
 * AFPS file fields are JSON Schema string nodes carrying `format: "uri"` plus a
 * `contentMediaType` (single file), or an array whose `items` are such nodes
 * (multiple files) — NEVER `type: "file"` (AFPS §3.4). The rule deliberately
 * does NOT require `type === "string"` on the single-field branch: that
 * preserves the historical observable behaviour of `@appstrate/core/form`'s
 * `isFileField` (its widest consumer set), and AFPS file fields are strings
 * anyway so the looser check is sound.
 *
 * Accepts a permissive `unknown` input narrowed internally so both the
 * JSONSchema7-typed core call site and the `unknown`-typed runtime call site
 * compile against one definition.
 */

/** Narrow an `unknown` schema node to an indexable object, or `undefined`. */
function asNode(schema: unknown): Record<string, unknown> | undefined {
  return schema && typeof schema === "object" ? (schema as Record<string, unknown>) : undefined;
}

/**
 * A single file field: `format: "uri"` + a DECLARED `contentMediaType`.
 *
 * "Declared" is `!= null && !== false`, deliberately NOT truthiness: the
 * keyword's presence is what marks the field as a file, and whether its value
 * is a well-formed media type is the manifest validator's job, not this
 * predicate's. `contentMediaType: ""` is therefore a file field — the same
 * reading `apps/api/src/services/inline-run.ts` documents and relies on.
 */
export function isSingleFileNode(schema: unknown): boolean {
  const node = asNode(schema);
  if (!node) return false;
  return node.format === "uri" && node.contentMediaType != null && node.contentMediaType !== false;
}

/**
 * Resolve a node's `items` schema, handling the JSON Schema boolean / tuple
 * forms (`items: false` → none; `items: [first, …]` → first object entry).
 */
export function resolveItems(schema: unknown): Record<string, unknown> | undefined {
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
export function resolveType(schema: unknown): string | undefined {
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
export function isFileField(schema: unknown): boolean {
  return isSingleFileNode(schema) || isMultipleFileField(schema);
}

/**
 * Detect a MULTIPLE-files field: an array whose `items` are a single file node.
 *
 * Shares {@link isSingleFileNode} with {@link isFileField} by construction, so
 * the two can never disagree about the same array node — they did, when
 * `@appstrate/core/form` carried its own copy that tested
 * `!!items.contentMediaType`: for `contentMediaType: ""` the field was a file
 * field that was not multiple, and the RJSF adapter rendered a single-file
 * widget bound to an array property.
 */
export function isMultipleFileField(schema: unknown): boolean {
  return resolveType(schema) === "array" && isSingleFileNode(resolveItems(schema));
}
