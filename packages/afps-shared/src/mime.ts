// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * MIME classification primitives — the ONE place that answers "is this media
 * type a text payload or an opaque binary container?".
 *
 * Lives in the zero-dependency shared package because the question is asked at
 * four layers that cannot import each other:
 *
 *  - **Platform API** (`apps/api/src/services/mime-policy.ts`) — sniff
 *    enforcement on uploads, MCP `resources/read` inlining.
 *  - **AFPS runtime** (`packages/afps-runtime` → `http-call-core.ts`) — decides
 *    whether an `http_call` response body is decoded as text or base64'd.
 *  - **Sidecar** (`runtime-pi/sidecar/mcp.ts`) — decides whether an `api_call`
 *    response is inlined as text or spilled to the blob store as bytes.
 *  - **Core** (`@appstrate/core/mime`) — re-exports this module verbatim, so
 *    the platform surface is unchanged.
 *
 * Every one of those had its own hand-rolled list, and the lists drifted:
 *
 *  - The MCP copy did not know about the YAML family, so a YAML document was
 *    base64-blobbed instead of being handed to the model as readable text.
 *  - The sidecar matched `contentType.includes("xml")`, which classifies
 *    `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` (an
 *    XLSX — a ZIP binary) as text. The UTF-8 decode replaced invalid bytes with
 *    U+FFFD and the re-encode wrote that corruption to disk, destroying every
 *    OOXML file downloaded through `responseMode.toFile`.
 *
 * Both bugs are the same bug: an ad-hoc list, matched by substring instead of
 * by media type. Add a format HERE, not at a call site.
 *
 * WHY this module sits in `@appstrate/afps-shared` rather than in core:
 * `@appstrate/afps-runtime` deliberately carries no runtime dependency on core
 * (it ships as a portable bundle runner and a standalone `afps` CLI; core sits
 * beside it in the dependency graph, not below it). For that reason the set
 * used to be hand-copied into `http-call-core.ts` with a parity test guarding
 * the copy — and it drifted three times anyway, once classifying XLSX as XML.
 * afps-shared is a `workspace:*` dependency of afps-runtime AND a published
 * dependency of core, so a single definition now reaches both without either
 * importing the other. That is the same "canonical source, core re-exports
 * verbatim" arrangement used by `ssrf.ts`, `credential-template.ts` and
 * `guarded-fetch.ts`.
 */

/**
 * Strip charset / boundary / other parameters from a MIME string and lowercase
 * it, so `text/csv; charset=utf-8` compares equal to `text/csv`.
 *
 * Every predicate in this module expects an already-normalized value —
 * classification and normalization stay separate so a caller that already holds
 * a bare media type does not pay for the split twice.
 */
export function normalizeMime(mime: string | null | undefined): string {
  if (!mime) return "";
  return mime.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

/**
 * Media types whose payload is text, matched EXACTLY. A substring test would
 * classify `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
 * as XML — see the module doc.
 */
export const TEXT_SHAPED_MEDIA_TYPES: ReadonlySet<string> = new Set([
  // JSON family
  "application/json",
  "application/ld+json",
  "application/x-ndjson",
  "application/jsonl",
  "application/json-seq",
  // XML family
  "application/xml",
  "application/xml-dtd",
  "application/xml-external-parsed-entity", // RFC 7303
  "image/svg+xml", // XML-based, file-type never matches it
  // YAML family
  "application/yaml",
  "application/x-yaml",
  // Scripting / tabular / form encodings with no magic signature
  "application/javascript",
  "application/x-javascript",
  "application/ecmascript",
  "application/csv",
  "application/x-sh",
  "application/x-httpd-php",
  "application/x-www-form-urlencoded",
]);

/**
 * Is this MIME text-shaped — i.e. does the format carry its payload as text
 * (plain text, JSON, CSV, XML source, YAML, JS, …) rather than as a binary
 * container?
 *
 * Expects a NORMALIZED media type ({@link normalizeMime}); a value carrying
 * `; charset=…` never matches the exact sets below.
 *
 * Four consumers ask this same question and must answer it identically:
 *
 *  - **Sniff enforcement** (`shouldEnforceSniffedMime`): text-shaped formats
 *    have no magic bytes, so `file-type` can never confirm them — the strict
 *    declared-vs-sniffed check is skipped and the declared mime trusted.
 *    Callers needing strict binary validation should declare a concrete binary
 *    MIME (application/pdf, image/*, …) which `file-type` can identify.
 *  - **MCP `resources/read`**: text-shaped bytes are inlined as a `text` block;
 *    anything else goes out as a base64 `blob`.
 *  - **HTTP response classification** (`api_call` / `http_call`): text-shaped
 *    bodies are UTF-8 decoded; anything else stays raw bytes. A false positive
 *    here is data loss, not a cosmetic mislabel — the decode is lossy
 *    (`fatal: false` → U+FFFD) and irreversible once re-encoded.
 *
 * `application/octet-stream` is deliberately absent: it is the explicit "opaque
 * blob" marker and MUST stay on the binary path even when its bytes happen to
 * be ASCII.
 */
export function isTextShapedMime(mime: string): boolean {
  if (mime.startsWith("text/")) return true;
  if (TEXT_SHAPED_MEDIA_TYPES.has(mime)) return true;
  // Structured-syntax suffixes (RFC 6839) — `+json`, `+xml`, `+yaml`.
  // Anything in these families is text-shaped and cannot be magic-sniffed.
  return mime.endsWith("+json") || mime.endsWith("+xml") || mime.endsWith("+yaml");
}

/**
 * Convenience wrapper for the common HTTP shape: classify a raw `Content-Type`
 * header value (parameters included) in one call.
 *
 * An absent or empty header is NOT text — a caller that wants to treat a
 * missing Content-Type as text must say so explicitly at its own call site,
 * because the safe default for unknown bytes is the binary path.
 */
export function isTextShapedContentType(contentType: string | null | undefined): boolean {
  const mime = normalizeMime(contentType);
  return mime !== "" && isTextShapedMime(mime);
}
