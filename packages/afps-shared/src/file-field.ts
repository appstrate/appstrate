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

/** A single file field: `format: "uri"` + a `contentMediaType`. */
function isSingleFileNode(node: Record<string, unknown>): boolean {
  return node.format === "uri" && node.contentMediaType != null && node.contentMediaType !== false;
}

/**
 * Resolve a node's `items` schema, handling the JSON Schema boolean / tuple
 * forms (`items: false` → none; `items: [first, …]` → first object entry).
 */
function resolveItems(node: Record<string, unknown>): Record<string, unknown> | undefined {
  const items = node.items;
  if (!items || typeof items === "boolean") return undefined;
  if (Array.isArray(items)) {
    const first = items[0];
    return first && typeof first === "object" ? (first as Record<string, unknown>) : undefined;
  }
  if (typeof items === "object") return items as Record<string, unknown>;
  return undefined;
}

function resolveType(node: Record<string, unknown>): string | undefined {
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
  if (!schema || typeof schema !== "object") return false;
  const node = schema as Record<string, unknown>;
  if (isSingleFileNode(node)) return true;
  if (resolveType(node) === "array") {
    const items = resolveItems(node);
    if (items && isSingleFileNode(items)) return true;
  }
  return false;
}
