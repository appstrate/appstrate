// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Wire format for `provider_call` upstream-response metadata threaded
 * back over MCP — sidecar-side serializer.
 *
 * The MCP `provider_call` tool's `CallToolResult` carries the upstream
 * payload via `content[]` (text or `resource_link`). HTTP status and
 * response headers historically were dropped; the resolver synthesised
 * `status: 200` and `headers: {}`. This worked for fire-and-forget
 * calls but broke any flow that needs a `Location:` header
 * (resumable uploads, redirects), an `ETag:` (S3 multipart part
 * tracking, optimistic concurrency), or `Upload-Offset:` (tus).
 *
 * The MCP spec allows arbitrary metadata on `CallToolResult` via
 * `_meta`; this module owns the namespaced key under which we ship
 * `{ status, headers }` and the allowlist applied at serialization
 * time. The companion parser lives at `runtime-pi/mcp/upstream-meta.ts`
 * — keep the allowlists in sync (a unit test asserts equality).
 *
 * Allowlist rationale: we never ship `set-cookie` (state-bearing
 * cookies are owned by the sidecar's cookie jar, not the agent),
 * `www-authenticate` (auth challenges are translated to
 * `X-Auth-Refreshed` semantics), or any header that could let a
 * malicious upstream influence the agent's runtime configuration.
 * Everything required by Google-resumable / S3-multipart / tus /
 * Microsoft-Graph upload protocols is on the list, plus a small set of
 * caching headers useful for general-purpose flows.
 */

/**
 * MCP `_meta` key under which the sidecar packages upstream HTTP
 * status + response headers. Namespaced to avoid colliding with
 * vendor-specific or future SDK-defined `_meta` keys.
 */
export const UPSTREAM_META_KEY = "appstrate/upstream";

/**
 * Headers the sidecar is willing to forward. Lowercase comparison;
 * outgoing keys are also lowercased so the resolver / agent never
 * see casing variance.
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
  // Throttling / rate limits (useful for adaptive backoff)
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
]);

/**
 * Serialised upstream metadata. Always sent on success; absent on
 * tool-level errors that originate INSIDE the sidecar (no upstream
 * call was made), present on tool-level errors that originate from a
 * 4xx/5xx upstream response.
 */
export interface UpstreamMeta {
  /** Upstream HTTP status code. */
  status: number;
  /** Lowercased, allowlisted upstream response headers. */
  headers: Record<string, string>;
}

/**
 * Project a `Headers` object into the allowlisted, lowercased
 * `Record<string, string>` we ship over MCP. Returns an empty object
 * when nothing matches — never `undefined` (the resolver expects a
 * well-formed `headers` field).
 */
export function projectAllowedHeaders(source: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of source) {
    const lower = name.toLowerCase();
    if (UPSTREAM_HEADER_ALLOWLIST.has(lower)) {
      out[lower] = value;
    }
  }
  return out;
}

/**
 * Build the `_meta` payload for a CallToolResult given an upstream
 * `Response`. The Response body is NOT consumed — the caller still
 * owns it for `content[]` materialization.
 */
export function buildUpstreamMeta(response: Response): UpstreamMeta {
  return {
    status: response.status,
    headers: projectAllowedHeaders(response.headers),
  };
}
