// SPDX-License-Identifier: Apache-2.0

/**
 * Idempotency key storage — backed by KeyValueCache adapter.
 *
 * Pattern: Stripe `Idempotency-Key` header, a key being scoped to the caller's credentials.
 * Cache key format: `idem:{orgId}:{spaceId}:{principal}:{key}` ({@link idempotencyPrincipal}),
 * so another principal reusing a key — even with the same body — is a fresh request, never a replay.
 * TTL: 24 hours. Request hash SHA-256 for conflict detection.
 *
 * The space id is part of the key so the SAME `Idempotency-Key` used by
 * two different spaces in one org never collides — without it, space A's
 * cached response could replay to space B (same org + key + body). Org-scoped
 * routes with no space context pass `undefined`, which maps to a stable
 * `_org` segment so they share one namespace among themselves.
 */

import { getCache } from "../infra/index.ts";
import type { Actor } from "./actor.ts";

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

/** The namespace one `Idempotency-Key` lives in. */
export interface IdempotencyScope {
  orgId: string;
  spaceId: string | undefined;
  /** {@link idempotencyPrincipal} of the authenticated caller. */
  principal: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TTL = 86_400; // 24 hours
const MAX_CACHED_BODY = 1_048_576; // 1 MB

/**
 * The caller a stored response belongs to: the auth method, the credential the request was
 * authenticated with — the API key, or the OAuth client a bearer token was issued to — and the
 * actor — the member, or the end-user an `Appstrate-User` header or an end-user token names. Each
 * key and each client is its own principal, whichever user it acts for. JSON-encoded so no two
 * tuples share a spelling, whatever an auth strategy puts in its method name.
 */
export function idempotencyPrincipal(caller: {
  authMethod: string;
  apiKeyId: string | null;
  clientId: string | null;
  actor: Actor;
}): string {
  return JSON.stringify([
    caller.authMethod,
    caller.apiKeyId,
    caller.clientId,
    caller.actor.type,
    caller.actor.id,
  ]);
}

function cacheKey(scope: IdempotencyScope, key: string): string {
  return `idem:${scope.orgId}:${scope.spaceId ?? "_org"}:${scope.principal}:${key}`;
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
  scope: IdempotencyScope,
  key: string,
  requestHash: string,
): Promise<LockResult> {
  const ck = cacheKey(scope, key);
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
  scope: IdempotencyScope,
  key: string,
  result: CachedResult,
): Promise<void> {
  // Don't cache oversized responses
  if (result.body.length > MAX_CACHED_BODY) {
    await releaseIdempotencyLock(scope, key);
    return;
  }

  const value = JSON.stringify(result);

  await (await getCache()).set(cacheKey(scope, key), value, { ttlSeconds: TTL });
}

export async function releaseIdempotencyLock(scope: IdempotencyScope, key: string): Promise<void> {
  await (await getCache()).del(cacheKey(scope, key));
}
