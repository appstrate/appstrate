// SPDX-License-Identifier: Apache-2.0

/**
 * Idempotency key storage — backed by KeyValueCache adapter.
 *
 * Pattern: Stripe `Idempotency-Key` header. Cache key format:
 * `idem:{orgId}:{spaceId}:{key}`.
 * TTL: 24 hours. Request hash SHA-256 for conflict detection.
 *
 * The space id is part of the key so the SAME `Idempotency-Key` used by
 * two different spaces in one org never collides — without it, space A's
 * cached response could replay to space B (same org + key + body). Org-scoped
 * routes with no space context pass `undefined`, which maps to a stable
 * `_org` segment so they share one namespace among themselves.
 */

import { getCache } from "../infra/index.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CachedResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  requestHash: string;
}

type LockResult =
  | { status: "acquired" }
  | { status: "processing" }
  | { status: "cached"; result: CachedResult }
  | { status: "request_mismatch" };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TTL = 86_400; // 24 hours
const MAX_CACHED_BODY = 1_048_576; // 1 MB

function cacheKey(orgId: string, spaceId: string | undefined, key: string): string {
  return `idem:${orgId}:${spaceId ?? "_org"}:${key}`;
}

export function computeRequestHash(request: Request, body: string): string {
  const url = new URL(request.url);
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(JSON.stringify([request.method, url.pathname, url.search, body]));
  return hasher.digest("hex");
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export async function acquireIdempotencyLock(
  orgId: string,
  spaceId: string | undefined,
  key: string,
  requestHash: string,
): Promise<LockResult> {
  const ck = cacheKey(orgId, spaceId, key);
  const processingValue = JSON.stringify({ status: "processing", requestHash });
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
  // Missing identity is a conflict too: never replay or execute an unbound entry.
  if (parsed.requestHash !== requestHash) return { status: "request_mismatch" };
  if (parsed.status === "processing") return { status: "processing" };
  return { status: "cached", result: parsed as CachedResult };
}

export async function storeIdempotencyResult(
  orgId: string,
  spaceId: string | undefined,
  key: string,
  result: CachedResult,
): Promise<void> {
  // Don't cache oversized responses
  if (result.body.length > MAX_CACHED_BODY) {
    await releaseIdempotencyLock(orgId, spaceId, key);
    return;
  }

  const ck = cacheKey(orgId, spaceId, key);
  const value = JSON.stringify(result);

  await (await getCache()).set(ck, value, { ttlSeconds: TTL });
}

export async function releaseIdempotencyLock(
  orgId: string,
  spaceId: string | undefined,
  key: string,
): Promise<void> {
  await (await getCache()).del(cacheKey(orgId, spaceId, key));
}
