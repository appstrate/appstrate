// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Wire format for `provider_call` upstream-response metadata —
 * runtime-pi (agent-side) parser. The companion serializer lives at
 * `runtime-pi/sidecar/upstream-meta.ts`; both files MUST agree on the
 * `_meta` key and the allowlisted header set.
 *
 * Why duplicate: sidecar runs in its own container with only
 * `runtime-pi/sidecar/` copied; runtime-pi runs in the agent
 * container with `runtime-pi/mcp/` and `runtime-pi/extensions/`
 * copied. Neither can import the other's tree at runtime. A unit
 * test (`runtime-pi/test/upstream-meta-parity.test.ts`) asserts the
 * key + allowlist agree across the two files so drift is caught at
 * `bun test` time, not at `provider_upload` runtime.
 */

import type { CallToolResult } from "@appstrate/mcp-transport";

/**
 * MCP `_meta` key under which the sidecar packages upstream HTTP
 * status + response headers. Must match
 * `runtime-pi/sidecar/upstream-meta.ts:UPSTREAM_META_KEY`.
 */
export const UPSTREAM_META_KEY = "appstrate/upstream";

/**
 * Headers the agent is willing to consume. Must match
 * `runtime-pi/sidecar/upstream-meta.ts:UPSTREAM_HEADER_ALLOWLIST`.
 *
 * Defence-in-depth: even though the sidecar already filters, the
 * resolver re-applies the allowlist on parse so a compromised /
 * misbehaving sidecar can't slip a header through.
 */
export const UPSTREAM_HEADER_ALLOWLIST = new Set<string>([
  // HTTP infrastructure
  "content-type",
  "content-length",
  "content-encoding",
  "content-language",
  "content-disposition",
  "content-range",
  "accept-ranges",
  "cache-control",
  "etag",
  "last-modified",
  "expires",
  "vary",
  "retry-after",
  "link",
  // Redirects + session URLs (Google resumable, Microsoft Graph)
  "location",
  // tus protocol headers
  "upload-offset",
  "upload-length",
  "upload-expires",
  "upload-metadata",
  "tus-resumable",
  "tus-extension",
  "tus-version",
  "tus-max-size",
  "tus-checksum-algorithm",
  // S3 / GCS multipart
  "x-amz-version-id",
  "x-amz-request-id",
  "x-amz-id-2",
  "x-amz-server-side-encryption",
  "x-goog-generation",
  "x-goog-metageneration",
  "x-goog-stored-content-length",
  // Range / partial-content
  "range",
  // Throttling / rate limits
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
]);

export interface UpstreamMeta {
  status: number;
  headers: Record<string, string>;
}

/**
 * Read upstream `{ status, headers }` from a CallToolResult's `_meta`
 * field, applying the allowlist defensively.
 *
 * Returns `undefined` when the sidecar is older than this propagation
 * change (no `_meta`) — callers must fall back to the legacy synthesised
 * `200` / `{}` behaviour for backwards compatibility with deployments
 * that haven't rolled the sidecar yet.
 *
 * Returns `undefined` (not throws) on malformed payloads — a poisoned
 * `_meta` should not crash the agent run; the legacy fallback is
 * the safer behaviour. The malformation is logged via
 * `console.warn` so deployment drift is at least visible.
 */
export function readUpstreamMeta(result: CallToolResult): UpstreamMeta | undefined {
  const meta = result._meta as Record<string, unknown> | undefined;
  if (!meta) return undefined;
  const raw = meta[UPSTREAM_META_KEY];
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null) {
    console.warn(`[upstream-meta] expected object at '${UPSTREAM_META_KEY}', got ${typeof raw}`);
    return undefined;
  }
  const obj = raw as { status?: unknown; headers?: unknown };
  if (typeof obj.status !== "number" || !Number.isInteger(obj.status)) {
    console.warn(`[upstream-meta] missing/invalid status field`);
    return undefined;
  }
  const headersRaw = obj.headers;
  if (typeof headersRaw !== "object" || headersRaw === null) {
    console.warn(`[upstream-meta] missing/invalid headers field`);
    return undefined;
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(headersRaw as Record<string, unknown>)) {
    if (typeof value !== "string") continue;
    const lower = name.toLowerCase();
    if (UPSTREAM_HEADER_ALLOWLIST.has(lower)) {
      headers[lower] = value;
    }
  }
  return { status: obj.status, headers };
}

/**
 * Build a synthetic `Response` carrying the upstream status + headers
 * but a caller-supplied body. Used by the resolver's `serializeFetchResponse`
 * pipeline to make file-routing / hashing / MIME sniffing identical
 * across resolver paths — the agent sees the upstream response shape
 * verbatim while the runtime owns body materialization.
 *
 * Status codes that disallow a body per RFC 7230 (1xx / 204 / 205 /
 * 304) are converted to 200 — the `Response` constructor rejects them
 * with a non-null body, and the body bytes are real (we already
 * received them). The synthetic status is preserved on the headers
 * via `x-upstream-status` so observers can still see the original
 * code if they care.
 */
export function synthesiseUpstreamResponse(
  body: BodyInit,
  meta: UpstreamMeta | undefined,
  fallbackContentType: string,
): Response {
  const status = meta?.status ?? 200;
  const headers = new Headers();
  if (meta?.headers) {
    for (const [name, value] of Object.entries(meta.headers)) {
      headers.set(name, value);
    }
  }
  if (!headers.has("content-type")) {
    headers.set("content-type", fallbackContentType);
  }
  // RFC 7230 §3.3.3: 1xx / 204 / 205 / 304 must not carry a body. The
  // `Response` constructor enforces this. Substitute 200 + a marker
  // header so we don't crash; in practice these codes never appear on
  // the response path we care about (proxy upstreams).
  if (status === 204 || status === 205 || status === 304 || (status >= 100 && status < 200)) {
    headers.set("x-upstream-status", String(status));
    return new Response(body, { status: 200, headers });
  }
  return new Response(body, { status, headers });
}
