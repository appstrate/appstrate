// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Runtime-side parser for `provider_call` upstream-response metadata.
 * The wire format (key + allowlist + `UpstreamMeta` type) lives in
 * `@appstrate/mcp-transport/upstream-meta`; both the sidecar
 * serializer and this parser import from there so they cannot drift.
 *
 * Contract:
 *
 * - Every `provider_call` `CallToolResult` MUST carry `_meta` under
 *   {@link UPSTREAM_META_KEY}. The sidecar attaches it on every return
 *   path — including pre-flight failures (credential fetch, URL
 *   allowlist, body too large) which surface as `status: 0`,
 *   `headers: {}`. The runtime no longer accepts a missing `_meta` —
 *   that pre-`_meta` shape was a backwards-compat shim for sidecars
 *   older than the runtime in the same release; sidecar and runtime
 *   are now built from the same source tree per release, so the shim
 *   is dead code.
 *
 * Defence-in-depth: the runtime re-applies the allowlist on parse so
 * a compromised / misbehaving sidecar can't slip a header through —
 * this is the second layer behind the sidecar's own filter.
 */

import {
  UPSTREAM_HEADER_ALLOWLIST,
  UPSTREAM_META_KEY,
  type UpstreamMeta,
} from "@appstrate/mcp-transport";
import type { CallToolResult } from "@appstrate/mcp-transport";

// Re-export shared symbols so in-tree consumers (provider-resolver,
// provider-upload-resolver, parity tests if any survive) can keep
// importing from `./upstream-meta` without churn.
export {
  UPSTREAM_HEADER_ALLOWLIST,
  UPSTREAM_META_KEY,
  type UpstreamMeta,
} from "@appstrate/mcp-transport";

/**
 * Read upstream `{ status, headers }` from a CallToolResult's `_meta`
 * field, applying the allowlist defensively. Throws on malformed or
 * missing payloads — the sidecar must always ship `_meta`, so anything
 * else is a protocol violation.
 */
export function readUpstreamMeta(result: CallToolResult): UpstreamMeta {
  const meta = result._meta as Record<string, unknown> | undefined;
  if (!meta) {
    throw new Error(`provider_call: missing _meta on CallToolResult — sidecar protocol violation`);
  }
  const raw = meta[UPSTREAM_META_KEY];
  if (raw === undefined) {
    throw new Error(`provider_call: missing _meta['${UPSTREAM_META_KEY}'] on CallToolResult`);
  }
  if (typeof raw !== "object" || raw === null) {
    throw new Error(
      `provider_call: _meta['${UPSTREAM_META_KEY}'] must be an object, got ${typeof raw}`,
    );
  }
  const obj = raw as { status?: unknown; headers?: unknown };
  if (typeof obj.status !== "number" || !Number.isInteger(obj.status)) {
    throw new Error(`provider_call: _meta['${UPSTREAM_META_KEY}'].status must be an integer`);
  }
  const headersRaw = obj.headers;
  if (typeof headersRaw !== "object" || headersRaw === null) {
    throw new Error(`provider_call: _meta['${UPSTREAM_META_KEY}'].headers must be an object`);
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
  meta: UpstreamMeta,
  fallbackContentType: string,
): Response {
  const status = meta.status;
  const headers = new Headers();
  for (const [name, value] of Object.entries(meta.headers)) {
    headers.set(name, value);
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
