// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical AFPS file-field predicate, used by `@appstrate/afps-runtime`'s
 * platform-prompt composer.
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
 *
 * ── `@appstrate/core/form` HAS A PARALLEL COPY OF THIS RULE, ON PURPOSE ──
 * Only `isFileField` is exported from the `@appstrate/afps-shared@0.5.0` on
 * npm, which is the floor `@appstrate/core` declares (`^0.5.0`). Core ships as
 * source, so a consumer's `tsc` compiles core's files against THAT install —
 * importing `isMultipleFileField` / `resolveItems` / `resolveType` from here
 * typechecks in this workspace and fails on npm. Core therefore carries its own
 * copy, derived from the same single-file-node rule; `packages/core/test/
 * form.test.ts` asserts the two agree table-wide, so a change made HERE and not
 * there (or vice versa) fails that test.
 *
 * Merging them is a release operation, in this order: publish an
 * `@appstrate/afps-shared` release exporting these helpers → raise core's
 * `dependencies["@appstrate/afps-shared"]` floor to it → replace core's copy
 * with an import. Not before.
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
 * `@appstrate/core/form`'s `isMultipleFileField` tested
 * `!!items.contentMediaType` (truthiness) against an `isFileField` that tested
 * "declared": for `contentMediaType: ""` the field was a file field that was
 * not multiple, and the RJSF adapter rendered a single-file widget bound to an
 * array property. Core's copy is now derived the same way; see the header for
 * why it is still a copy.
 */
export function isMultipleFileField(schema: unknown): boolean {
  return resolveType(schema) === "array" && isSingleFileNode(resolveItems(schema));
}
