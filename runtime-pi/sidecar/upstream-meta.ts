// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Sidecar-side serializer for `api_call` upstream-response
 * metadata. The wire format (key + allowlist + `UpstreamMeta` type)
 * lives in `@appstrate/mcp-transport/upstream-meta` so the sidecar
 * and the runtime-pi parser share a single source of truth.
 *
 * This module owns the projection / build helpers — the bits that
 * touch a live `Response` object on the sidecar side and produce a
 * value the runtime can consume verbatim.
 */

import { UPSTREAM_HEADER_ALLOWLIST, type UpstreamMeta } from "@appstrate/mcp-transport";

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

/**
 * The upstream `_meta` of an `api_call` the sidecar answered itself (a pre-flight refusal, or
 * a failure after sending): status 0, so the parser can tell it from "upstream returned 5xx".
 */
export function buildSidecarAnswerUpstreamMeta(): UpstreamMeta {
  return { status: 0, headers: {} };
}
