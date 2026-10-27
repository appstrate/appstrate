// SPDX-License-Identifier: Apache-2.0

/**
 * Short-TTL cache of resolved models, shared by `loadModel` (reader) and the
 * credential and model mutators (invalidation). A single chat turn / agent run
 * fans out into many `loadModel(orgId, presetId, payer)` calls — the llm-proxy
 * resolves the preset on EVERY inference request — and each resolution reads
 * the model row, the payer's personal credentials and the credential blob.
 * The cache answers a warm resolution with zero queries, and because it is a
 * `@appstrate/core/cache`, concurrent resolves of one model coalesce into a
 * single load.
 *
 * Lives in its own module (not `org-models.ts`) so `credentials.ts` can bust it
 * on a credential mutation WITHOUT an import cycle (`org-models` already imports
 * `credentials`). The `ResolvedModel` value type is a TYPE-ONLY import — erased
 * at runtime, so it introduces no runtime dependency edge.
 *
 * Security: an entry carries the decrypted credential and is keyed by the payer,
 * so two members never share one. A disable / rotation / reconnection-flag change
 * or a personal-credential change MUST invalidate it: every such mutator calls
 * `clearResolvedModelCache()`. The clear is immediate WITHIN the process and
 * broadcast on the platform cache bus (`lib/cache-bus.ts`), so another replica
 * drops its copy within a round trip; a lost broadcast falls back to the 30 s
 * TTL. The value never leaves the process: the bus carries cache names and keys,
 * never entries.
 */

import { createCache } from "@appstrate/core/cache";
import type { ResolvedModel } from "./org-models.ts";

const TTL_MS = 30_000;

const cache = createCache<ResolvedModel | null>({
  name: "resolved-model",
  ttlMs: TTL_MS,
  max: 2000,
});

/**
 * What a resolution is keyed by: the payer's chain (`viaProxy` for the LLM proxy,
 * which never serves a subscription) or a run's launch credential. The payer is
 * part of the key, so two members never share an entry.
 */
export type ResolvedModelSlot =
  | { readonly kind: "payer"; readonly payerUserId: string | null; readonly viaProxy: boolean }
  | { readonly kind: "run"; readonly credentialId: string; readonly payerUserId: string | null };

function slotKey(orgId: string, modelDbId: string, slot: ResolvedModelSlot): string {
  const parts =
    slot.kind === "payer"
      ? ["payer", slot.payerUserId, slot.viaProxy]
      : ["run", slot.credentialId, slot.payerUserId];
  return JSON.stringify([orgId, modelDbId, ...parts]);
}

/**
 * Resolve one model under `slot`. `null` (unknown / disabled model, dead credential)
 * is answered but never stored.
 */
export function resolveModelCached(
  orgId: string,
  modelDbId: string,
  slot: ResolvedModelSlot,
  loader: () => Promise<ResolvedModel | null>,
): Promise<ResolvedModel | null> {
  return cache.get(slotKey(orgId, modelDbId, slot), loader, {
    store: (value) => value !== null,
  });
}

/**
 * Drop the whole cache — call on a credential or model mutation. An entry depends
 * on up to three rows (model, payer credential, org credential) and the bus carries
 * one key at a time, so there is no cheap by-row eviction. These mutations are rare
 * admin or refresh-worker operations; the cache just rebuilds on next use.
 */
export function clearResolvedModelCache(): void {
  cache.clear();
}
