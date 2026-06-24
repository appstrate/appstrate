// SPDX-License-Identifier: Apache-2.0

/**
 * Short-TTL cache of resolved DB models, shared by `loadModel` (writer/reader)
 * and the credential mutators (invalidation). A single chat turn / agent run
 * fans out into many `loadModel(orgId, presetId)` calls — the llm-proxy resolves
 * the preset on EVERY inference request (up to MAX_STEPS per turn) — each
 * otherwise re-queries `org_models` + the credential row and re-decrypts. The
 * cache collapses that to one resolve per window.
 *
 * Lives in its own module (not `org-models.ts`) so `credentials.ts` can bust it
 * on a credential mutation WITHOUT an import cycle (`org-models` already imports
 * `credentials`). The `ResolvedModel` value type is a TYPE-ONLY import — erased
 * at runtime, so it introduces no runtime dependency edge.
 *
 * Security: the cached value carries the decrypted credential, so a disable /
 * rotation / reconnection-flag change MUST invalidate it immediately (not wait
 * out the TTL). Every credential mutator calls `clearResolvedModelCache()`; the
 * TTL is only a backstop for anything not explicitly wired.
 */

import type { ResolvedModel } from "./org-models.ts";

const TTL_MS = 30_000;
const MAX = 500;

const cache = new Map<string, { value: ResolvedModel; exp: number }>();

const keyOf = (orgId: string, modelDbId: string): string => `${orgId}:${modelDbId}`;

export function getResolvedModel(orgId: string, modelDbId: string): ResolvedModel | null {
  const hit = cache.get(keyOf(orgId, modelDbId));
  if (hit && hit.exp > Date.now()) return hit.value;
  return null;
}

export function setResolvedModel(orgId: string, modelDbId: string, value: ResolvedModel): void {
  const key = keyOf(orgId, modelDbId);
  if (cache.size >= MAX && !cache.has(key)) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, exp: Date.now() + TTL_MS });
}

/** Drop one model's entry — call when that specific model row changes. */
export function invalidateResolvedModel(orgId: string, modelDbId: string): void {
  cache.delete(keyOf(orgId, modelDbId));
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
