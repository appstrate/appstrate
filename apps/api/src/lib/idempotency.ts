// SPDX-License-Identifier: Apache-2.0

/**
 * Idempotency key storage — backed by KeyValueCache adapter.
 *
 * Pattern: Stripe `Idempotency-Key` header. Cache key format: `idem:{orgId}:{key}`.
 * TTL: 24 hours. Body hash SHA-256 for conflict detection.
 */

import { getCache } from "../infra/index.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CachedResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  bodyHash: string;
}

type LockResult =
  | { status: "acquired" }
  | { status: "processing" }
  | { status: "cached"; result: CachedResult };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TTL = 86_400; // 24 hours
const MAX_CACHED_BODY = 1_048_576; // 1 MB

function cacheKey(orgId: string, key: string): string {
  return `idem:${orgId}:${key}`;
}

export function computeBodyHash(body: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(body);
  return hasher.digest("hex");
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export async function acquireIdempotencyLock(
  orgId: string,
  key: string,
  bodyHash: string,
): Promise<LockResult> {
  const ck = cacheKey(orgId, key);
  const processingValue = JSON.stringify({ status: "processing", bodyHash });
  const cache = await getCache();

  // Atomic SET NX with TTL
  const acquired = await cache.set(ck, processingValue, { ttlSeconds: TTL, nx: true });

  if (acquired) {
    return { status: "acquired" };
  }

  // Key exists — read the current value
  const existing = await cache.get(ck);
  if (!existing) {
    // Race: key expired between SET and GET — retry
    const retryAcquired = await cache.set(ck, processingValue, { ttlSeconds: TTL, nx: true });
    if (retryAcquired) return { status: "acquired" };
    return { status: "processing" };
  }

  const parsed = JSON.parse(existing);
  if (parsed.status === "processing") return { status: "processing" };
  return { status: "cached", result: parsed as CachedResult };
}

export async function storeIdempotencyResult(
  orgId: string,
  key: string,
  result: CachedResult,
): Promise<void> {
  // Don't cache oversized responses
  if (result.body.length > MAX_CACHED_BODY) {
    await releaseIdempotencyLock(orgId, key);
    return;
  }

  const ck = cacheKey(orgId, key);
  const value = JSON.stringify(result);

  (await getCache()).set(ck, value, { ttlSeconds: TTL });
}

export async function releaseIdempotencyLock(orgId: string, key: string): Promise<void> {
  (await getCache()).del(cacheKey(orgId, key));
}
