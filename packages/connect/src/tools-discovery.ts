// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 1.2a — `toolsDynamic` runtime re-discovery + drift detection
 * (proposal §5.4.6 + §5.4.3).
 *
 * Two responsibilities, kept in one module because they share the lock
 * snapshot:
 *
 *   1. {@link discoverToolsForUser} — fetch the upstream MCP server's
 *      `tools/list` for a `(integrationId, userId, connectedAuthsKey)`
 *      triple and cache the result for 24h. The cache key intentionally
 *      mixes auth set so two users with overlapping-but-different
 *      connected auths see overlapping-but-different tool surfaces.
 *
 *   2. {@link diffToolsAgainstLock} — compare a re-discovered tool list
 *      against the `tools.lock.json` snapshot baked into the bundle at
 *      publish time. Emits structured `added` / `removed` /
 *      `schemaChanged` lists so the consumer can gate re-consent
 *      (added/expanded scopes) or silently retire deprecated tools.
 *
 * Pure + DB-free + network-free. The MCP client is injected, the clock
 * is injected, the cache is in-process — wiring of cache invalidation
 * to `notifications/tools/list_changed` happens at the consumer (the
 * orchestrator already has the `AppstrateMcpClient` reference).
 */

/**
 * Minimal local mirror of the MCP SDK's `Tool` shape. Keeping it here
 * (instead of importing from `@modelcontextprotocol/sdk`) preserves
 * the package boundary: `@appstrate/connect` consumers (registry, cloud)
 * must not transitively pull the MCP SDK.
 */
export interface Tool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  [key: string]: unknown;
}

// ─────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────

export const DEFAULT_TOOLS_DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Sole input required by the discoverer. The MCP client must already
 * be connected — the caller (Phase 1.2a orchestrator) owns the
 * lifecycle.
 */
export interface ToolsDiscoveryRequest {
  /** Stable id for the integration (typically `package.id`). */
  integrationId: string;
  /** Owner — dashboard user OR headless end-user; whatever the caller uses elsewhere. */
  userId: string;
  /** Stable string identifying which auths are connected (sorted, joined). */
  connectedAuthsKey: string;
  /** Injected MCP client. Anything implementing `listTools()` works. */
  client: { listTools(): Promise<{ tools: Tool[] }> };
}

export interface ToolsDiscoveryOptions {
  /** Cache TTL (ms). Defaults to 24h per §5.4.6. */
  ttlMs?: number;
  /** Injectable clock — replaces `Date.now`. */
  now?: () => number;
  /**
   * Per-request bypass — useful for first-spawn (no cache yet) or
   * after the consumer received `notifications/tools/list_changed`.
   */
  skipCache?: boolean;
}

export interface DiscoveredTools {
  tools: Tool[];
  cachedAt: number;
  /** When this entry expires (`cachedAt + ttlMs`). */
  expiresAt: number;
  /** True when the result came from cache instead of a fresh list. */
  fromCache: boolean;
}

// ─────────────────────────────────────────────
// Cache
// ─────────────────────────────────────────────

interface CacheEntry {
  tools: Tool[];
  cachedAt: number;
  expiresAt: number;
}

// Process-wide cache. The cache key is computed from the request triple;
// `clearToolsDiscoveryCache()` clears everything (test hook).
const cache = new Map<string, CacheEntry>();

function cacheKey(
  req: Pick<ToolsDiscoveryRequest, "integrationId" | "userId" | "connectedAuthsKey">,
): string {
  return `${req.integrationId}::${req.userId}::${req.connectedAuthsKey}`;
}

/** Test hook — wipe the in-process cache. */
export function clearToolsDiscoveryCache(): void {
  cache.clear();
}

/** Test hook — surface current cache size for assertions. */
export function toolsDiscoveryCacheSize(): number {
  return cache.size;
}

// ─────────────────────────────────────────────
// Discoverer
// ─────────────────────────────────────────────

/**
 * Returns a fresh-or-cached `tools/list` snapshot. Cache misses always
 * round-trip the MCP client; hits within TTL skip the call.
 *
 * Per §5.4.6, if re-discovery throws, the caller is expected to
 * **fail closed** — refuse the run for this integration. We surface the
 * error directly so the caller can attach a structured user-actionable
 * message rather than swallowing the underlying transport error.
 */
export async function discoverToolsForUser(
  request: ToolsDiscoveryRequest,
  options: ToolsDiscoveryOptions = {},
): Promise<DiscoveredTools> {
  const ttlMs = options.ttlMs ?? DEFAULT_TOOLS_DISCOVERY_TTL_MS;
  const now = options.now ?? Date.now;
  const key = cacheKey(request);

  if (!options.skipCache) {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now()) {
      return {
        tools: hit.tools,
        cachedAt: hit.cachedAt,
        expiresAt: hit.expiresAt,
        fromCache: true,
      };
    }
  }

  const { tools } = await request.client.listTools();
  const cachedAt = now();
  const expiresAt = cachedAt + ttlMs;
  cache.set(key, { tools, cachedAt, expiresAt });
  return { tools, cachedAt, expiresAt, fromCache: false };
}

/** Manual invalidation — used by the orchestrator on `tools/list_changed` or auth reconnect. */
export function invalidateToolsForUser(
  request: Pick<ToolsDiscoveryRequest, "integrationId" | "userId" | "connectedAuthsKey">,
): void {
  cache.delete(cacheKey(request));
}

/** Bulk invalidation — used when ALL auths of an integration reconnect. */
export function invalidateToolsForIntegration(integrationId: string): void {
  const prefix = `${integrationId}::`;
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

// ─────────────────────────────────────────────
// Drift detection
// ─────────────────────────────────────────────

export interface ToolsDiff {
  /** Tools present in the live result but not in the lock — require re-consent. */
  added: string[];
  /** Tools present in the lock but missing from the live result — silently retired. */
  removed: string[];
  /**
   * Tools where the `inputSchema` JSON shape changed. The consumer
   * uses this to gate re-consent when the schema grows new required
   * properties or describes a wider effective scope.
   */
  schemaChanged: string[];
  /** True when added/removed/schemaChanged are all empty. */
  identical: boolean;
}

/**
 * Diff a fresh `tools/list` result against the `tools.lock.json` snapshot
 * baked into the bundle at publish time.
 *
 * The schema comparison is a byte-stable JSON stringify — fragile to
 * key ordering, but the publish-time extractor uses the same stable
 * stringify so the comparison is meaningful in practice. A future
 * iteration may switch to a semantic JSON Schema diff once we have a
 * stable subset to compare against.
 */
export function diffToolsAgainstLock(
  liveTools: ReadonlyArray<Tool>,
  lockTools: ReadonlyArray<Tool>,
): ToolsDiff {
  const liveByName = new Map(liveTools.map((t) => [t.name, t]));
  const lockByName = new Map(lockTools.map((t) => [t.name, t]));

  const added: string[] = [];
  const removed: string[] = [];
  const schemaChanged: string[] = [];

  for (const [name, lock] of lockByName) {
    if (!liveByName.has(name)) {
      removed.push(name);
      continue;
    }
    const live = liveByName.get(name)!;
    if (stableStringify(live.inputSchema) !== stableStringify(lock.inputSchema)) {
      schemaChanged.push(name);
    }
  }
  for (const name of liveByName.keys()) {
    if (!lockByName.has(name)) added.push(name);
  }

  added.sort();
  removed.sort();
  schemaChanged.sort();

  return {
    added,
    removed,
    schemaChanged,
    identical: added.length === 0 && removed.length === 0 && schemaChanged.length === 0,
  };
}

/**
 * Build the canonical connectedAuthsKey string for a given set of
 * authKeys. Sorts + dedupes + joins with `,` — used by the cache key
 * so callers don't need to do this themselves.
 */
export function buildConnectedAuthsKey(authKeys: ReadonlyArray<string>): string {
  const unique = Array.from(new Set(authKeys));
  unique.sort();
  return unique.join(",");
}

// ─────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────

/**
 * Stable stringify with deterministic key order. `inputSchema` is the
 * only thing we serialize, and it is a finite JSON document; an
 * iterative implementation is enough.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}
