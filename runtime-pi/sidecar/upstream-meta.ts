// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Sidecar-side serializer for `provider_call` upstream-response
 * metadata. The wire format (key + allowlist + `UpstreamMeta` type)
 * lives in `@appstrate/mcp-transport/upstream-meta` so the sidecar
 * and the runtime-pi parser share a single source of truth.
 *
 * This module owns the projection / build helpers — the bits that
 * touch a live `Response` object on the sidecar side and produce a
 * value the runtime can consume verbatim.
 */

import { UPSTREAM_HEADER_ALLOWLIST, type UpstreamMeta } from "@appstrate/mcp-transport";

// Re-export the shared constants/types so existing in-tree imports
// (sidecar/mcp.ts) keep resolving against `./upstream-meta` without a
// churn-only rename pass.
export {
  UPSTREAM_META_KEY,
  UPSTREAM_HEADER_ALLOWLIST,
  type UpstreamMeta,
} from "@appstrate/mcp-transport";

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
 * Strip userinfo and fragment from a URL before exposing it on
 * `_meta`. Mirrors WHATWG Fetch `Response.url` semantics — both are
 * dropped to "avoid leaking information about redirects". Returns
 * `undefined` if the URL is unparseable so a malformed upstream
 * `Location` cannot poison the envelope.
 */
function sanitizeFinalUrl(url: string): string | undefined {
  try {
    const u = new URL(url);
    u.username = "";
    u.password = "";
    u.hash = "";
    return u.toString();
  } catch {
    return undefined;
  }
}

/**
 * Build the `_meta` payload for a CallToolResult given an upstream
 * `Response`. The Response body is NOT consumed — the caller still
 * owns it for `content[]` materialization.
 *
 * `finalUrl` is the URL the response was eventually served from after
 * the sidecar's redirect follower (manual or Bun native). Sanitised
 * here (userinfo + fragment stripped) so callers cannot accidentally
 * leak basic-auth credentials into the agent's context window.
 */
export function buildUpstreamMeta(response: Response, finalUrl?: string): UpstreamMeta {
  const sanitised = finalUrl !== undefined ? sanitizeFinalUrl(finalUrl) : undefined;
  return {
    status: response.status,
    headers: projectAllowedHeaders(response.headers),
    ...(sanitised !== undefined ? { finalUrl: sanitised } : {}),
  };
}

/**
 * Build a sidecar-pre-flight `_meta` payload. Used when the sidecar
 * fails before issuing the upstream request (credential fetch failure,
 * URL not in `authorizedUris`, body too large) — we still attach
 * `_meta` so the runtime parser can rely on `_meta` always being
 * present, distinguishing "no upstream contact" (status 0) from
 * "upstream returned 5xx" via the status code rather than the absence
 * of metadata.
 */
export function buildPreflightUpstreamMeta(): UpstreamMeta {
  return { status: 0, headers: {} };
}
