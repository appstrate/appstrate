// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Roots URI validation (Phase 3a of #276, V8 in the migration plan).
 *
 * The agent (MCP client) declares which file:// and s3:// URIs it
 * considers in-bounds via `roots/list`. When a tool argument carries
 * a URI reference (e.g. `provider_call` with
 * `body: { type: "resource", uri: "..." }`), the sidecar must validate
 * the URI is within a declared root before dereferencing it.
 *
 * This module is the single source of truth for that validation. It
 * is intentionally restrictive: anything not explicitly allowed by a
 * root is rejected. Path traversal sequences (`..`, percent-encoded
 * variants, multiple slashes) are blocked at the grammar level so the
 * caller never sees an attacker-shaped URI.
 *
 * Why a separate module: the same validation runs in two places —
 * `provider_call` argument validation (via the MCP server handler) and
 * any future direct-read primitive (e.g. an `appstrate://run-input`
 * scheme). Centralising avoids drift.
 */

export interface RootDeclaration {
  /** Boundary URI the client declared via `roots/list`. */
  uri: string;
  /** Optional human-friendly name; logged but never trusted for control flow. */
  name?: string;
}

export type RootValidationResult =
  | { ok: true; matched: RootDeclaration }
  | { ok: false; reason: string };

const ALLOWED_SCHEMES = new Set(["file:", "s3:", "appstrate:"]);

/**
 * Determine whether `uri` is rooted under any of the supplied roots.
 *
 * Rules (all must hold):
 *   1. URI parses as a URL object (no malformed input).
 *   2. URI scheme is in {@link ALLOWED_SCHEMES}.
 *   3. URI does NOT contain `..`, `//` after scheme://, or
 *      percent-encoded path-traversal sequences.
 *   4. URI starts with one of the declared root URIs (after both are
 *      normalized — trailing slash is significant; root must end in
 *      `/` to constrain to a directory).
 *
 * Caller is expected to call `client.listRoots()` once per request
 * (or cache for the request lifetime) and pass the result here. We
 * deliberately don't cache inside this module — staleness is the
 * caller's call.
 */
export function validateUriAgainstRoots(
  uri: string,
  roots: ReadonlyArray<RootDeclaration>,
): RootValidationResult {
  if (typeof uri !== "string" || uri.length === 0) {
    return { ok: false, reason: "uri must be a non-empty string" };
  }
  if (uri.includes("..")) {
    return { ok: false, reason: "uri contains path traversal sequence" };
  }
  // Reject percent-encoded `..`, `/`, `\` to defeat single-decode bypasses.
  if (/%2[fF]|%2[eE]|%5[cC]/.test(uri)) {
    return { ok: false, reason: "uri contains percent-encoded traversal vector" };
  }

  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return { ok: false, reason: "uri is not a valid URL" };
  }
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    return { ok: false, reason: `uri scheme '${parsed.protocol}' is not allowed` };
  }
  // Spec is silent on `//` in path — we treat it as suspicious because
  // many path libraries normalise it incorrectly.
  if (parsed.pathname.includes("//")) {
    return { ok: false, reason: "uri pathname contains empty segments" };
  }

  for (const root of roots) {
    let rootUrl: URL;
    try {
      rootUrl = new URL(root.uri);
    } catch {
      // Skip malformed roots — caller bug; fail closed by ignoring.
      continue;
    }
    if (rootUrl.protocol !== parsed.protocol) continue;
    if (rootUrl.host !== parsed.host) continue;
    // Root must be a directory boundary — must end in `/`. Otherwise
    // `s3://bucket/runs/run1` would also match `runs/run10`.
    const rootPath = rootUrl.pathname.endsWith("/") ? rootUrl.pathname : `${rootUrl.pathname}/`;
    if (parsed.pathname.startsWith(rootPath)) {
      return { ok: true, matched: root };
    }
  }

  return { ok: false, reason: "uri is not within any declared root" };
}
