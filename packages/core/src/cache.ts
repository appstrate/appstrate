// SPDX-License-Identifier: Apache-2.0

/**
 * The platform's one read-through cache primitive. Every process-local TTL
 * cache in the platform and its modules is an instance of it:
 *
 *  - **read-through**: `get(key, loader)` returns the cached value or runs the
 *    loader ONCE per key while it is in flight (request coalescing) — the
 *    llm-proxy calls that resolve one model preset at the start of a turn
 *    share a single row read and decrypt.
 *  - **bounded**: a TTL per cache and a hard entry cap with insertion-order
 *    eviction, so a cache can never hold more than its declared budget.
 *  - **invalidation with a bus**: `invalidate(key)` and `clear()` drop the
 *    local entry AND publish the fact on the configured {@link CacheBus}, so a
 *    replica that did not take the write drops its copy too, within a round
 *    trip instead of a TTL. The transport is the platform's: `apps/api` wires
 *    it to `pg_notify`/`LISTEN`, which every tier from PGlite up already
 *    provides — no Redis required for cross-replica coherence.
 *
 * What it deliberately is NOT: a shared (L2) store. The values cached here are
 * single-row reads that cost about a network round trip — a Redis hop would
 * cost the same — and some carry decrypted credentials that must never sit in
 * a shared store in plaintext. Coherence is the property worth having across
 * replicas; storage is not.
 *
 * Caches are registered by name so a bus message can be routed to the right
 * instance. Names are process-unique; registering one twice is a programming
 * error and throws, never silently shadows.
 *
 * Time is read through a process-wide clock seam ({@link setCacheClock}) so a
 * test can advance every cache at once without a per-cache option; production
 * never sets it.
 */

/** A message telling every replica to drop one entry (`key`) or all (`null`). */
export interface CacheInvalidation {
  /** The cache's registered name. */
  cache: string;
  /** The entry to drop, or `null` for the whole cache. */
  key: string | null;
  /** The publishing process, so a replica can ignore its own broadcast. */
  origin: string;
}

/**
 * The transport for invalidations. `publish` must never throw and never block:
 * a lost broadcast degrades to the TTL. Delivery calls
 * {@link receiveCacheInvalidation}.
 */
export interface CacheBus {
  publish(message: CacheInvalidation): void;
}

/** Any value but `undefined` — `undefined` is the cache's own "absent" (see {@link Cache}). */
type Storable = NonNullable<unknown> | null;

export interface CacheOptions {
  /** Process-unique name — the routing key on the bus. */
  name: string;
  /** Entry lifetime from the moment it is stored. */
  ttlMs: number;
  /** Hard cap on entries; the oldest inserted entry is evicted past it. Default 1000. */
  max?: number;
}

export interface CacheGetOptions<V extends Storable> {
  /**
   * Whether a freshly loaded value is worth keeping. Default: always. A loader
   * that answers `undefined` is never stored regardless (see {@link Cache.get});
   * this is for a cache whose loader uses another "not found" value, such as
   * `null`, and wants that answer retried on the next call rather than
   * remembered for a TTL.
   */
  store?: (value: V) => boolean;
}

/**
 * `V` is constrained to non-`undefined` values (`null` is allowed): `undefined`
 * is the cache's own "absent" — a loader that answers it is answered but never
 * stored, so the next call loads again. A cache that must remember "not found"
 * uses `null`.
 */
export interface Cache<V extends Storable> {
  /** The cached value, or the loader's result — one loader call per key in flight. */
  get(key: string, loader: () => Promise<V>, options?: CacheGetOptions<V>): Promise<V>;
  /** Same, for a loader that may answer `undefined`: answered, never stored. */
  get(
    key: string,
    loader: () => Promise<V | undefined>,
    options?: CacheGetOptions<V>,
  ): Promise<V | undefined>;
  /** The cached value if present and fresh, without loading. */
  peek(key: string): V | undefined;
  /** Store a value the caller already has. */
  set(key: string, value: V): void;
  /** Drop one entry here and on every replica. */
  invalidate(key: string): void;
  /** Drop every entry here and on every replica. */
  clear(): void;
}

interface Entry<V> {
  value: V;
  expiresAt: number;
}

const DEFAULT_MAX = 1_000;

/** Which process this is, for the bus to tell a broadcast from its own echo. */
const ORIGIN = crypto.randomUUID();

/** What a delivered invalidation needs from a registered cache. */
interface Droppable {
  drop(key: string): void;
  dropAll(): void;
}

const registry = new Map<string, Droppable>();
let bus: CacheBus | null = null;
let clock: () => number = Date.now;

/**
 * Point every cache at one clock. Tests only — pass `null` to restore
 * `Date.now`. A per-cache option would have to be threaded through every
 * module that owns a cache; the seam being global is what keeps it out of
 * their signatures.
 */
export function setCacheClock(now: (() => number) | null): void {
  clock = now ?? Date.now;
}

/**
 * Install the invalidation transport. `null` disconnects (the caches keep
 * working, invalidations stay process-local). Called once at boot by the
 * platform; a module never configures it.
 */
export function configureCacheBus(transport: CacheBus | null): void {
  bus = transport;
}

/**
 * Apply an invalidation delivered by the transport. Idempotent (dropping an
 * absent entry is a no-op), ignores this process's own broadcasts, and ignores
 * a cache name this process does not know — a replica running a different
 * module set may legitimately own caches this one does not.
 */
export function receiveCacheInvalidation(message: CacheInvalidation): void {
  if (message.origin === ORIGIN) return;
  const target = registry.get(message.cache);
  if (!target) return;
  if (message.key === null) target.dropAll();
  else target.drop(message.key);
}

/** Drop every entry of every cache, locally. Tests only (`truncateAll`). */
export function clearAllCachesLocally(): void {
  for (const cache of registry.values()) cache.dropAll();
}

class InternalCache<V extends Storable> implements Cache<V>, Droppable {
  private readonly entries = new Map<string, Entry<V>>();
  /** Loads in flight, each tagged so a completed load can tell whether it still owns its slot. */
  private readonly inflight = new Map<string, { promise: Promise<V | undefined>; token: symbol }>();
  private readonly max: number;

  constructor(
    private readonly name: string,
    private readonly ttlMs: number,
    max: number,
  ) {
    this.max = max;
  }

  peek(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= clock()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  get(key: string, loader: () => Promise<V>, options?: CacheGetOptions<V>): Promise<V>;
  get(
    key: string,
    loader: () => Promise<V | undefined>,
    options?: CacheGetOptions<V>,
  ): Promise<V | undefined>;
  async get(
    key: string,
    loader: () => Promise<V | undefined>,
    options?: CacheGetOptions<V>,
  ): Promise<V | undefined> {
    const cached = this.peek(key);
    if (cached !== undefined) return cached;
    const pending = this.inflight.get(key);
    if (pending) return pending.promise;

    const token = Symbol("load");
    const promise = (async () => {
      const value = await loader();
      // Store only while this load still owns the slot: an `invalidate` that
      // landed mid-flight dropped it, and what this load fetched is exactly the
      // value that write made stale. The caller still gets its answer.
      const owned = this.inflight.get(key)?.token === token;
      if (owned && value !== undefined && (options?.store ? options.store(value) : true)) {
        this.set(key, value);
      }
      return value;
    })();
    this.inflight.set(key, { promise, token });
    try {
      return await promise;
    } finally {
      // Only the load this call registered — a concurrent `invalidate` may
      // already have cleared the slot for a newer load to take.
      if (this.inflight.get(key)?.token === token) this.inflight.delete(key);
    }
  }

  set(key: string, value: V): void {
    if (this.entries.size >= this.max && !this.entries.has(key)) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: clock() + this.ttlMs });
  }

  invalidate(key: string): void {
    this.drop(key);
    bus?.publish({ cache: this.name, key, origin: ORIGIN });
  }

  clear(): void {
    this.dropAll();
    bus?.publish({ cache: this.name, key: null, origin: ORIGIN });
  }

  /** Local drop, no broadcast — what a delivered invalidation applies. */
  drop(key: string): void {
    this.entries.delete(key);
    // A load in flight for this key predates the invalidation: whatever it
    // stores would be the stale value the caller just declared wrong.
    this.inflight.delete(key);
  }

  dropAll(): void {
    this.entries.clear();
    this.inflight.clear();
  }
}

/**
 * Create and register a cache. One call per cache, at module load, next to
 * the reads it fronts. Throws on a name already registered in this process.
 */
export function createCache<V extends Storable>(options: CacheOptions): Cache<V> {
  if (registry.has(options.name)) {
    throw new Error(`cache "${options.name}" is already registered`);
  }
  if (!(options.ttlMs > 0)) {
    throw new Error(`cache "${options.name}": ttlMs must be positive`);
  }
  const cache = new InternalCache<V>(options.name, options.ttlMs, options.max ?? DEFAULT_MAX);
  registry.set(options.name, cache);
  return cache;
}
