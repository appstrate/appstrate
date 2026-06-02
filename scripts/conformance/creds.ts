// SPDX-License-Identifier: Apache-2.0

/**
 * Test-credential resolution for the live tiers (remote MCP parity,
 * auth-liveness). Opt-in: a package is only exercised live when a credential
 * is present, otherwise its handler degrades to a SKIP/WARN.
 *
 * `CONFORMANCE_TOKENS` is a JSON object mapping package id → bearer access
 * token, e.g. {"@appstrate/notion-mcp":"secret_...","@appstrate/github-mcp":"ghp_..."}.
 * One CI secret covers every provider; coverage grows by adding entries.
 *
 * (Our providers issue long-lived or non-expiring tokens, so a plain string is
 * enough — none hand out OAuth refresh tokens. ClickUp's token expires with no
 * refresh path, so it is covered by manual `workflow_dispatch`, not the cron.)
 */

const ENV_KEY = "CONFORMANCE_TOKENS";

let cache: Record<string, string> | null = null;

/** Parse `CONFORMANCE_TOKENS` once. Invalid JSON → empty map. */
function load(): Record<string, string> {
  if (cache) return cache;
  const raw = process.env[ENV_KEY];
  const map: Record<string, string> = {};
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === "string" && v.length > 0) map[k] = v;
        }
      }
    } catch {
      // invalid JSON → empty map
    }
  }
  cache = map;
  return cache;
}

/** Bearer access token for a package, or undefined when none is configured. */
export function resolveToken(packageId: string): string | undefined {
  return load()[packageId];
}

/** Number of configured credentials — for "N covered" reporting. */
export function credentialedCount(): number {
  return Object.keys(load()).length;
}

/** Reset the parse cache (tests). */
export function _resetCredsCache(): void {
  cache = null;
}
