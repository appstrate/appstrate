// SPDX-License-Identifier: Apache-2.0

/**
 * Response-level cache for `/api/llm-proxy/*`. Opt-in via
 * `LLM_PROXY_CACHE_MODE` (off | simple). Emits
 * `x-llm-proxy-cache-status: HIT | MISS` on cached responses.
 *
 * Scope:
 *   - Non-streaming JSON only. Streaming SSE bypasses the cache — a
 *     cached SSE replay is far less useful and complicates the contract.
 *   - 2xx upstream responses only — error replies must not be served from
 *     a stale cache (token-counting, quota, rate-limit responses
 *     legitimately change between calls).
 *   - Org-private. The key embeds `orgId` + `presetId` so two orgs
 *     querying the same model with the same prompt never share state.
 *
 * Backend selection: Redis when `REDIS_URL` is set, in-memory per-process
 * otherwise (Tier 0).
 *
 * Failure mode:
 *   Any cache backend hiccup is swallowed (`logger.warn`, fall through
 *   to the upstream call). The cache is an optimisation — it must not
 *   take a request down with it.
 */

import { getCache } from "../../infra/index.ts";
import { logger } from "../../lib/logger.ts";

/**
 * Cached response payload. Stored as JSON in the KV cache.
 * `headers` is a flat record because `Headers` doesn't serialise; we
 * rebuild the runtime Headers on the read side.
 */
interface CachedEntry {
  version: 1;
  status: number;
  headers: Record<string, string>;
  body: string;
  storedAt: number;
}

const ENTRY_VERSION = 1;

/**
 * Headers we copy from upstream into the cache + replay. We exclude
 * transport-specific noise (Set-Cookie, CF-Ray, request-ids) so cache
 * replays don't carry over the original transaction's metadata.
 */
const CACHE_REPLAY_HEADERS = new Set([
  "content-type",
  "ratelimit-limit",
  "ratelimit-remaining",
  "ratelimit-reset",
  "ratelimit-policy",
]);

/** Canonical key shape: hash so the Redis key length stays bounded. */
function buildCacheKey(input: {
  orgId: string;
  presetId: string;
  apiShape: string;
  upstreamModelId: string;
  requestBody: Uint8Array;
}): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(input.orgId);
  h.update("\0");
  h.update(input.presetId);
  h.update("\0");
  h.update(input.apiShape);
  h.update("\0");
  h.update(input.upstreamModelId);
  h.update("\0");
  h.update(input.requestBody);
  return `llm-proxy:cache:v${ENTRY_VERSION}:${h.digest("hex")}`;
}

interface CacheLookupInput {
  orgId: string;
  presetId: string;
  apiShape: string;
  upstreamModelId: string;
  requestBody: Uint8Array;
}

interface CacheHit {
  response: Response;
  cacheKey: string;
}

/**
 * Probe the cache. Returns a pre-built Response on hit, or a key
 * descriptor (for the writer) on miss. Cache-backend errors return
 * `{ hit: false, cacheKey: null }` so the caller uniformly falls
 * through to the upstream path. The caller is responsible for not
 * invoking `lookupResponse` on streaming requests — `core.ts` reads
 * `stream` from the already-parsed body and skips the lookup entirely.
 */
export async function lookupResponse(
  input: CacheLookupInput,
): Promise<{ hit: false; cacheKey: string | null } | (CacheHit & { hit: true })> {
  const cacheKey = buildCacheKey(input);
  let raw: string | null;
  try {
    const cache = await getCache();
    raw = await cache.get(cacheKey);
  } catch (err) {
    logger.warn("llm-proxy: cache lookup failed (fall-through)", {
      cacheKey,
      error: err instanceof Error ? err.message : String(err),
    });
    return { hit: false, cacheKey: null };
  }
  if (!raw) return { hit: false, cacheKey };

  let parsed: CachedEntry;
  try {
    parsed = JSON.parse(raw) as CachedEntry;
    if (parsed.version !== ENTRY_VERSION) return { hit: false, cacheKey };
  } catch {
    // Garbage in the slot — treat as miss; the next write overwrites it.
    return { hit: false, cacheKey };
  }

  const headers = new Headers(parsed.headers);
  headers.set("x-llm-proxy-cache-status", "HIT");
  return {
    hit: true,
    cacheKey,
    response: new Response(parsed.body, { status: parsed.status, headers }),
  };
}

interface CacheStoreInput {
  cacheKey: string;
  ttlSeconds: number;
  status: number;
  headers: Headers;
  body: string;
}

/**
 * Persist a 2xx upstream response. Idempotent — concurrent writers
 * setting the same key overwrite each other (last-write-wins is fine
 * for content-addressable LLM responses).
 */
export async function storeResponse(input: CacheStoreInput): Promise<void> {
  if (input.status < 200 || input.status >= 300) return;
  // We only store responses for prompts that come back fast enough to be
  // worth caching at all; the gateway-side `simple` mode behaves the
  // same way. The strict 2xx gate keeps quota/rate-limit failures off
  // the replay path.
  const headers: Record<string, string> = {};
  input.headers.forEach((v, k) => {
    if (CACHE_REPLAY_HEADERS.has(k.toLowerCase())) headers[k] = v;
  });
  const entry: CachedEntry = {
    version: ENTRY_VERSION,
    status: input.status,
    headers,
    body: input.body,
    storedAt: Date.now(),
  };
  try {
    const cache = await getCache();
    await cache.set(input.cacheKey, JSON.stringify(entry), { ttlSeconds: input.ttlSeconds });
  } catch (err) {
    logger.warn("llm-proxy: cache write failed", {
      cacheKey: input.cacheKey,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
