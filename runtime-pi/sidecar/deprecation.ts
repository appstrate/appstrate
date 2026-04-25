// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Deprecation header builder (Phase 3b of #276, V6 in the migration plan).
 *
 * RFC 9745 (Deprecation) + RFC 8594 (Sunset) instruct HTTP clients
 * that a route is being phased out. Adding these headers is the first
 * milestone in the 18-month removal cycle defined in V6 — they're
 * machine-readable so external operators can build dashboards on the
 * deprecation state without grepping log lines.
 *
 * What we apply to which route:
 * - `/llm/*` — replaced by the MCP `llm_complete` tool. Agents on
 *   RUNTIME_MCP_CLIENT=1 should NEVER hit this route directly.
 * - `/proxy` (when `X-Stream-Response: 1` is set) — replaced by
 *   `provider_call` returning a `resource_link` block. The non-streaming
 *   `/proxy` path is NOT deprecated (still load-bearing for non-MCP
 *   runtime-pi paths until Phase 6).
 *
 * Sunset date: 2027-10-25 = 18 months from this PR's land date.
 * The platform's removal gate (per V6 telemetry rules) may bring the
 * actual removal earlier or push it later. The header is a *promise*
 * to clients, not a binding contract; the operator dashboard owns the
 * actual cutoff decision.
 */

/**
 * RFC 9745 `Deprecation` header value: an HTTP date describing when
 * the route was officially marked deprecated. Pinned to the migration
 * plan's authoring date so the value is stable across releases.
 */
export const DEPRECATION_DATE = "Wed, 25 Apr 2026 00:00:00 GMT";

/**
 * RFC 8594 `Sunset` header value: 18 months from {@link DEPRECATION_DATE}.
 */
export const SUNSET_DATE = "Mon, 25 Oct 2027 00:00:00 GMT";

/**
 * Migration guide URL — surfaced via the `Link; rel="sunset"` header so
 * `mcp-inspector` and other tooling can surface a one-click pointer.
 */
export const MIGRATION_GUIDE_URL =
  "https://github.com/appstrate/appstrate/blob/main/docs/migrations/MCP_V2.md";

/**
 * Standard set of headers to apply to deprecated routes. Always
 * returns the same shape — no cleverness — so callers can spread it
 * directly and reviewers can verify each route's deprecation surface
 * by string-grepping for `DEPRECATION_HEADERS`.
 */
export const DEPRECATION_HEADERS: Record<string, string> = {
  Deprecation: DEPRECATION_DATE,
  Sunset: SUNSET_DATE,
  Link: `<${MIGRATION_GUIDE_URL}>; rel="sunset"; type="text/markdown"`,
};
