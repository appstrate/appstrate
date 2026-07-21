// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical `document://` (and companion `upload://`) URI contract.
 *
 * The durable document store addresses every stored file by an opaque,
 * stable `document://doc_xxx` URI; a staged (not-yet-materialized) upload
 * carries the ephemeral `upload://upl_xxx` form. Both the platform
 * (apps/api documents/uploads services + MCP router) and the chat module
 * validate/parse these URIs, so the pure, dependency-free helpers live here
 * — one source of truth for the prefix + id shape — rather than being
 * re-implemented per consumer (the earlier state: four near-identical copies
 * of the prefix literals and id regex).
 *
 * Dependency-free on purpose (no DB/storage imports) so the MCP tool layer,
 * the chat module, and the runtime can import it without pulling in the
 * documents service's graph.
 */

/** `document://doc_xxx` — the opaque, stable URI form of a stored document. */
export const DOCUMENT_URI_PREFIX = "document://";

/** `upload://upl_xxx` — the ephemeral URI form of a staged (not-yet-materialized) upload. */
export const UPLOAD_URI_PREFIX = "upload://";

/**
 * Strict document id shape: `doc_` + ≥8 id chars. `prefixedId("doc")` is well
 * above this, so the bound is safely below the real minimum. Rejects malformed
 * input before it reaches any database SELECT. Mirrors the service-side
 * validator (`apps/api/src/services/documents.ts`).
 */
export const DOCUMENT_ID_RE = /^doc_[A-Za-z0-9_-]{8,}$/;

/** Strict upload id shape: `upl_` + ≥8 id chars. Mirrors the uploads service validator. */
export const UPLOAD_ID_RE = /^upl_[A-Za-z0-9_-]{8,}$/;

/** Is this value a `document://…` reference (prefix only, id not validated)? */
export function isDocumentUri(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(DOCUMENT_URI_PREFIX);
}

/** Is this value an `upload://…` reference (prefix only, id not validated)? */
export function isUploadUri(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(UPLOAD_URI_PREFIX);
}

/**
 * Does `value` carry an accepted chat-attachment scheme (`upload://` or
 * `document://`)? Attachments flow only through the document store, never
 * inline (`data:`) or as arbitrary URLs.
 */
export function isAttachmentUri(value: unknown): value is string {
  return isUploadUri(value) || isDocumentUri(value);
}

/**
 * Extract the document id from a `document://doc_xxx` URI, validating the id
 * shape. Returns null if the prefix is absent or the id is malformed.
 */
export function parseDocumentUri(uri: string): string | null {
  if (!uri.startsWith(DOCUMENT_URI_PREFIX)) return null;
  const id = uri.slice(DOCUMENT_URI_PREFIX.length);
  return DOCUMENT_ID_RE.test(id) ? id : null;
}

/** The `document://` URI for a document id. */
export function documentUri(id: string): string {
  return `${DOCUMENT_URI_PREFIX}${id}`;
}
