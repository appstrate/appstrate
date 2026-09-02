// SPDX-License-Identifier: Apache-2.0

/**
 * Short-TTL cache of ONE field of `organizations.org_settings`: the
 * `api_version` pin. Read by `getCachedOrgApiVersion` (`organizations.ts`)
 * and busted by every settings writer in that file.
 *
 * Why only the pin: the api-version middleware resolves the org's pin on
 * EVERY authenticated request. Session requests get it for free
 * (`requireOrgContext` loads the settings in the membership query and stashes
 * them on the context), but strategy-authenticated requests — the chat
 * module's in-process `chatloop_` dispatch, API keys — skip that middleware,
 * so each hop re-queried the organizations table: two queries per chat tool
 * call, four in the chat preamble. Nothing else in `org_settings` is on a hot
 * path, and the oidc module's `dashboard_sso_enabled` gate is a security
 * check that must read fresh — so `getOrgSettings` itself stays uncached and
 * this map holds nothing but the pin.
 *
 * Modelled on `resolved-model-cache.ts`: TTL map, bounded size with
 * insertion-order eviction, explicit invalidation, process-local, no import
 * of the service that reads it (so there is no cycle with `organizations.ts`).
 *
 * Staleness contract. Invalidation is immediate WITHIN a process — every
 * writer drops the org's entry after its write commits. There is no
 * cross-instance pub/sub, so on a multi-instance deployment ANOTHER replica
 * may keep serving the previous pin for up to `TTL_MS` after an admin re-pins.
 * Accepted because re-pinning is a rare, explicit admin action, and because
 * the per-request `Appstrate-Version` header override is resolved BEFORE the
 * org pin is consulted (`middleware/api-version.ts`) and never touches this
 * cache — a caller who needs a specific version right now can always ask for
 * it explicitly. Anything that writes the pin outside `organizations.ts` (a
 * direct SQL update in a test, a data migration) must call
 * `invalidateOrgApiVersion` itself or accept the TTL.
 *
 * The clock is injectable (`configureOrgApiVersionCache({ now })`) so tests
 * can cross the TTL boundary without sleeping; production never calls it.
 */

const TTL_MS = 10_000;
const MAX = 1_000;

/** `value` is the pin, or null for an org with no pin (also worth caching). */
const cache = new Map<string, { value: string | null; exp: number }>();

let now: () => number = Date.now;

/**
 * Swap the clock the TTL is measured against. Pass `{}` to restore
 * `Date.now`. Test seam only — documented here so it is not mistaken for a
 * runtime knob.
 */
export function configureOrgApiVersionCache(options: { now?: () => number }): void {
  now = options.now ?? Date.now;
}

/** `undefined` = miss (or expired); `null` = cached "no pin". */
export function getCachedApiVersionEntry(orgId: string): string | null | undefined {
  const hit = cache.get(orgId);
  if (hit && hit.exp > now()) return hit.value;
  return undefined;
}

export function setCachedApiVersionEntry(orgId: string, value: string | null): void {
  if (cache.size >= MAX && !cache.has(orgId)) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(orgId, { value, exp: now() + TTL_MS });
}

/** Drop one org's entry — call after any write to that org's settings commits. */
export function invalidateOrgApiVersion(orgId: string): void {
  cache.delete(orgId);
}

/** Drop every entry. Used by the test harness between tests; no runtime caller. */
export function clearOrgApiVersionCache(): void {
  cache.clear();
}
