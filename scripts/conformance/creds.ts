// SPDX-License-Identifier: Apache-2.0

/**
 * Test-credential resolution for the live tiers (remote MCP parity,
 * auth-liveness). Opt-in by design: a package is only exercised live when a
 * credential is present, otherwise its handler degrades to a SKIP/WARN.
 *
 * Mechanism: a single `CONFORMANCE_TOKENS` env var holding a JSON object that
 * maps package id → bearer access token, e.g.
 *
 *   CONFORMANCE_TOKENS='{"@appstrate/clickup-mcp":"ya29...."}'
 *
 * One CI secret covers every provider, and coverage grows by adding map
 * entries. Tokens are pre-minted (operator- or CI-supplied); automatic
 * refresh-token exchange (`performRefreshTokenExchange`) is a documented
 * future enhancement, not required for a monitor run.
 */

const ENV_KEY = "CONFORMANCE_TOKENS";

let cache: Record<string, string> | null = null;

/** Parse `CONFORMANCE_TOKENS` once. Invalid JSON → empty map (logged by caller). */
function load(): Record<string, string> {
  if (cache) return cache;
  const raw = process.env[ENV_KEY];
  if (!raw) {
    cache = {};
    return cache;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const map: Record<string, string> = {};
    if (parsed && typeof parsed === "object") {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string" && v.length > 0) map[k] = v;
      }
    }
    cache = map;
  } catch {
    cache = {};
  }
  return cache;
}

/** Bearer access token for a package, or undefined when none is configured. */
export function resolveToken(packageId: string): string | undefined {
  return load()[packageId];
}

/** Number of configured credentials — for "N of M covered" reporting. */
export function credentialedCount(): number {
  return Object.keys(load()).length;
}

/** Reset the parse cache (tests). */
export function _resetCredsCache(): void {
  cache = null;
}
