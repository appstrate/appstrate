// SPDX-License-Identifier: Apache-2.0

/**
 * Short-TTL cache of resolved DB models, shared by `loadModel` (reader) and
 * the credential mutators (invalidation). A single chat turn / agent run fans
 * out into many `loadModel(orgId, presetId)` calls — the llm-proxy resolves
 * the preset on EVERY inference request (up to MAX_STEPS per turn) — each
 * otherwise re-querying `org_models` + the credential row and re-decrypting.
 * The cache collapses that to one resolve per window, and because it is a
 * `@appstrate/core/cache`, concurrent resolves of one preset coalesce into a
 * single load instead of racing each other to the same row.
 *
 * Lives in its own module (not `org-models.ts`) so `credentials.ts` can bust it
 * on a credential mutation WITHOUT an import cycle (`org-models` already imports
 * `credentials`). The `ResolvedModel` value type is a TYPE-ONLY import — erased
 * at runtime, so it introduces no runtime dependency edge.
 *
 * Security: the cached value carries the decrypted credential, so a disable /
 * rotation / reconnection-flag change MUST invalidate it. Every credential
 * mutator calls `clearResolvedModelCache()`. The clear is immediate WITHIN the
 * process and broadcast on the platform cache bus (`lib/cache-bus.ts`), so
 * another replica drops its copy within a round trip; a lost broadcast falls
 * back to the 30 s TTL. The value never leaves the process: the bus carries
 * cache names and keys, never entries.
 */

import { createCache } from "@appstrate/core/cache";
import type { ResolvedModel } from "./org-models.ts";

const TTL_MS = 30_000;

const cache = createCache<ResolvedModel | null>({
  name: "resolved-model",
  ttlMs: TTL_MS,
  max: 500,
});

const keyOf = (orgId: string, modelDbId: string): string => `${orgId}:${modelDbId}`;

/**
 * Resolve through the cache. `null` (unknown / disabled model, missing
 * credential) is answered but never stored — the next call retries, so a
 * model enabled a moment later is seen without waiting out a TTL.
 */
export function resolveModelCached(
  orgId: string,
  modelDbId: string,
  loader: () => Promise<ResolvedModel | null>,
): Promise<ResolvedModel | null> {
  return cache.get(keyOf(orgId, modelDbId), loader, { store: (value) => value !== null });
}

/** Drop one model's entry — call when that specific model row changes. */
export function invalidateResolvedModel(orgId: string, modelDbId: string): void {
  cache.invalidate(keyOf(orgId, modelDbId));
}

/**
 * Drop the whole cache — call on a credential mutation. A credential backs N
 * models (1:N); the cache is keyed by model id, so there's no cheap by-credential
 * eviction. Credential mutations are rare/admin/refresh-worker ops, so clearing
 * all is the simplest correct choice (the cache just rebuilds on next use).
 */
export function clearResolvedModelCache(): void {
  cache.clear();
}
