/**
 * Idempotency key storage — Redis-backed with in-memory fallback for tests.
 *
 * Pattern: Stripe `Idempotency-Key` header. Redis key format: `idem:{orgId}:{key}`.
 * TTL: 24 hours. Body hash SHA-256 for conflict detection.
 */

import { getRedisConnection } from "./redis.ts";

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
// Test support
// ---------------------------------------------------------------------------

let _useMemory = false;
const _memoryStore = new Map<string, string>();

export function _setIdempotencyMemoryForTesting(value: boolean): void {
  _useMemory = value;
}

export function _resetIdempotencyForTesting(): void {
  _memoryStore.clear();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TTL = 86_400; // 24 hours
const MAX_CACHED_BODY = 1_048_576; // 1 MB

function redisKey(orgId: string, key: string): string {
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
  const rk = redisKey(orgId, key);
  const processingValue = JSON.stringify({ status: "processing", bodyHash });

  if (_useMemory) {
    const existing = _memoryStore.get(rk);
    if (!existing) {
      _memoryStore.set(rk, processingValue);
      return { status: "acquired" };
    }
    const parsed = JSON.parse(existing);
    if (parsed.status === "processing") return { status: "processing" };
    return { status: "cached", result: parsed as CachedResult };
  }

  // Redis: SET NX EX (atomic lock)
  const redis = getRedisConnection();
  const set = await redis.set(rk, processingValue, "EX", TTL, "NX");

  if (set === "OK") {
    return { status: "acquired" };
  }

  // Key exists — read the current value
  const existing = await redis.get(rk);
  if (!existing) {
    // Race: key expired between SET and GET — retry the atomic SET NX
    const retrySet = await redis.set(rk, processingValue, "EX", TTL, "NX");
    if (retrySet === "OK") return { status: "acquired" };
    // Another process won — treat as concurrent
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

  const rk = redisKey(orgId, key);
  const value = JSON.stringify(result);

  if (_useMemory) {
    _memoryStore.set(rk, value);
    return;
  }

  await getRedisConnection().set(rk, value, "EX", TTL);
}

export async function releaseIdempotencyLock(orgId: string, key: string): Promise<void> {
  const rk = redisKey(orgId, key);

  if (_useMemory) {
    _memoryStore.delete(rk);
    return;
  }

  await getRedisConnection().del(rk);
}
