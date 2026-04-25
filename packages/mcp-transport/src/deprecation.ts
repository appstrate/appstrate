// SPDX-License-Identifier: Apache-2.0

/**
 * Deprecation header builders (Phase 6 of #276).
 *
 * RFC 9745 (Deprecation) + RFC 8594 (Sunset) instruct HTTP clients
 * that a route is being phased out. This module centralises the
 * header shape so every package — sidecar, registry, future hosts —
 * surfaces deprecation the same way and operator dashboards can grep
 * for one thing.
 *
 * Each entry in {@link DEPRECATIONS} corresponds to a route or surface
 * being removed under the migration plan's V6 18-month cycle. The
 * record is the source of truth: bumping a sunset date here is the
 * single edit that propagates to every consumer.
 *
 * Usage (sidecar):
 *
 * ```ts
 * import { deprecationHeaders } from "@appstrate/mcp-transport";
 * c.header("Deprecation", deprecationHeaders("legacy-llm-routes").Deprecation);
 * ```
 *
 * Or, more commonly, spread the whole record:
 *
 * ```ts
 * for (const [k, v] of Object.entries(deprecationHeaders("legacy-llm-routes"))) {
 *   c.header(k, v);
 * }
 * ```
 */

/** Format a JS `Date` into the IMF-fixdate string RFC 9745 mandates. */
function toImfFixdate(date: Date): string {
  return date.toUTCString();
}

/**
 * Migration guide URL — surfaced via `Link; rel="sunset"` so tooling
 * can offer a one-click pointer.
 */
export const MIGRATION_GUIDE_URL =
  "https://github.com/appstrate/appstrate/blob/main/docs/migrations/MCP_V2.md";

/**
 * Authoring date for the V2 migration. Pinned so the
 * `Deprecation` header is stable across releases.
 */
export const DEPRECATION_DATE_V2 = new Date("2026-04-25T00:00:00Z");

/**
 * Sunset date = `DEPRECATION_DATE_V2` + 18 months. Per V6 the operator
 * dashboard owns the actual cutoff decision; this header is a
 * machine-readable promise to clients.
 */
export const SUNSET_DATE_V2 = new Date("2027-10-25T00:00:00Z");

/**
 * Registered deprecations. Adding a new entry here is the only edit
 * required to mark a new route surface as phased-out — every consumer
 * resolves through this record.
 */
export const DEPRECATIONS = {
  /**
   * `/llm/*` routes — replaced by the MCP `llm_complete` tool. Agents
   * on `RUNTIME_MCP_CLIENT=1` should never hit these routes directly.
   */
  "legacy-llm-routes": {
    deprecation: DEPRECATION_DATE_V2,
    sunset: SUNSET_DATE_V2,
    guide: MIGRATION_GUIDE_URL,
  },
  /**
   * `/proxy?X-Stream-Response=1` — replaced by the MCP `provider_call`
   * tool returning a `resource_link` block (Phase 3a/3b of #276). The
   * non-streaming `/proxy` path is NOT deprecated yet.
   */
  "legacy-binary-passthrough": {
    deprecation: DEPRECATION_DATE_V2,
    sunset: SUNSET_DATE_V2,
    guide: MIGRATION_GUIDE_URL,
  },
} as const;

export type DeprecationId = keyof typeof DEPRECATIONS;

/**
 * Build the standard `Deprecation` / `Sunset` / `Link` triple for a
 * registered deprecation. Throws on unknown ids — adding a new id is
 * a deliberate edit to {@link DEPRECATIONS}, never a stringly-typed
 * surprise.
 */
export function deprecationHeaders(id: DeprecationId): Record<string, string> {
  const entry = DEPRECATIONS[id];
  return {
    Deprecation: toImfFixdate(entry.deprecation),
    Sunset: toImfFixdate(entry.sunset),
    Link: `<${entry.guide}>; rel="sunset"; type="text/markdown"`,
  };
}
