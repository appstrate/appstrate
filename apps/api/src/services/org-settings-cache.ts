// SPDX-License-Identifier: Apache-2.0

/**
 * The org `api_version` pin, cached for ten seconds — and ONLY the pin.
 *
 * Strategy-authenticated requests (the chat's `chatloop_` hops, API keys) skip
 * `requireOrgContext`, so the api-version middleware had no `orgSettings` on
 * the context and re-read the organizations row on every hop: four times in
 * the chat preamble and twice per tool call. This is that read, memoised.
 *
 * Why not cache `getOrgSettings` itself: the same row carries the oidc
 * dashboard-SSO gate, and a security gate must read fresh — a global settings
 * cache served a just-disabled gate for a TTL. The pin is the only field with
 * a hot read path, so it is the only field cached.
 *
 * Staleness: `updateOrgSettings` invalidates the entry after its write commits
 * and the invalidation is broadcast on the platform's cache bus
 * (`@appstrate/core/cache`, `lib/cache-bus.ts`), so other replicas drop their
 * copy within a round trip; a lost broadcast degrades to the ten-second TTL.
 * The `Appstrate-Version` request header is resolved before the pin and is
 * never cached.
 */

import { createCache } from "@appstrate/core/cache";

const TTL_MS = 10_000;

/** `orgId` → pin (`null` = unpinned, a cached answer in its own right). */
export const orgApiVersionCache = createCache<string | null>({
  name: "org-api-version",
  ttlMs: TTL_MS,
  max: 1_000,
});
