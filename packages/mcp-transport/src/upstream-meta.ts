// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Wire format for `provider_call` upstream-response metadata threaded
 * back over MCP — shared between the sidecar serializer and the
 * runtime-side parser.
 *
 * The MCP `provider_call` tool's `CallToolResult` carries the upstream
 * payload via `content[]` (text or `resource_link`). HTTP status and
 * response headers are out-of-band on `_meta`, under the namespaced
 * key {@link UPSTREAM_META_KEY}.
 *
 * Why this lives in `@appstrate/mcp-transport`: the sidecar (serializer)
 * and the runtime-pi agent (parser) live in distinct Docker images that
 * cannot import each other's tree at runtime, but both already depend
 * on `@appstrate/mcp-transport` for the MCP wire-format adapter. Hosting
 * the constants + types here is the canonical way to keep both sides in
 * lockstep without duplicating definitions or adding a parity test.
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
 * Headers the sidecar is willing to forward AND the runtime is willing
 * to consume. Lowercase comparison; outgoing keys are also lowercased
 * so the resolver / agent never see casing variance.
 *
 * Defence-in-depth: the runtime-side parser re-applies this allowlist
 * on parse so a compromised / misbehaving sidecar can't slip a header
 * through.
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
 * Serialised upstream metadata. Always present on every
 * `provider_call` `CallToolResult` regardless of success or failure:
 *
 * - On a real upstream exchange: `status` is the upstream HTTP code,
 *   `headers` is the allowlisted projection.
 * - On a sidecar pre-flight failure (no upstream contact — credential
 *   fetch failure, URL not in `authorizedUris`, body too large): the
 *   sidecar ships `status: 0`, `headers: {}` so the runtime can
 *   distinguish "no upstream contact" from "upstream returned 5xx"
 *   without relying on the absence of `_meta`.
 */
export interface UpstreamMeta {
  /** Upstream HTTP status code, or 0 for sidecar pre-flight failures. */
  status: number;
  /** Lowercased, allowlisted upstream response headers. */
  headers: Record<string, string>;
  /**
   * URL the response was eventually served from, after the sidecar
   * followed any 30x chain internally. Distinct from `headers.location`
   * which is the *next hop* on a non-terminal redirect — undefined on
   * the terminal hop. Omitted on preflight failures (no upstream
   * contact).
   *
   * Sanitised per WHATWG Fetch: userinfo (`user:pass@`) and fragment
   * (`#…`) are stripped before serialisation. Defence-in-depth: the
   * sidecar refuses redirects to non-allowlisted hosts, so the value
   * is always inside the provider's declared trust boundary.
   *
   * Use to extract callback query params (`?code=…`, `?ticket=…`,
   * `?state=…`) from multi-step OAuth Authorization Code / CAS /
   * magic-link flows that terminate via redirect on a 200/4xx.
   */
  finalUrl?: string;
}
