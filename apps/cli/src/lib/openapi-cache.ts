// SPDX-License-Identifier: Apache-2.0

/**
 * Per-profile OpenAPI schema cache with ETag/304 revalidation.
 *
 * Why cache at all: `GET /api/openapi.json` returns ~191 endpoints
 * (~several MB of JSON with all component schemas). Users typically
 * invoke `appstrate openapi list` / `show` many times in quick
 * succession while exploring. Re-downloading the full schema on every
 * invocation is wasteful and slow on high-latency connections.
 *
 * Strategy: one cache file + one ETag sibling per profile under
 * `$XDG_CACHE_HOME/appstrate/` (or `~/.cache/appstrate/`). On fetch:
 *
 *   1. Read the cached ETag (if any) and send it as `If-None-Match`.
 *   2. If the server replies 304, use the cached payload as-is.
 *   3. If the server replies 200, overwrite both cache + etag files.
 *   4. If the server returns no ETag header, cache the body without
 *      an ETag — the next invocation re-downloads but still benefits
 *      from the single round-trip (no extra 304 handshake needed).
 *
 * Corruption tolerance: a cache file that fails JSON.parse is treated
 * as a miss — we refetch unconditionally rather than propagating a
 * parse error to the user. Same for missing / partial ETag files.
 *
 * User-facing knobs:
 *   --no-cache  → skip cache lookup AND skip cache write (ephemeral)
 *   --refresh   → skip cache lookup (force a fresh fetch + ETag), but
 *                 still write the result to cache
 *
 * Tests: `apps/cli/test/openapi-cache.test.ts`.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { apiFetchRaw, AuthError } from "./api.ts";

/** Minimal OpenAPI 3.1 shape — only the fields we actually read. */
export interface OpenApiDocument {
  openapi?: string;
  info?: { title?: string; version?: string; description?: string };
  servers?: Array<{ url: string; description?: string }>;
  tags?: Array<{ name: string; description?: string }>;
  paths?: Record<string, Record<string, OpenApiOperation>>;
  components?: {
    schemas?: Record<string, unknown>;
    parameters?: Record<string, unknown>;
    responses?: Record<string, unknown>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
  parameters?: unknown[];
  requestBody?: unknown;
  responses?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Options controlling cache behavior for a single fetch. `noCache`
 * disables reads AND writes (ephemeral mode). `refresh` forces a
 * fresh fetch but still updates the cache on success — useful for
 * "invalidate and re-warm" without losing cache benefits on the next
 * invocation.
 */
export interface FetchOptions {
  noCache?: boolean;
  refresh?: boolean;
}

/** Where is $XDG_CACHE_HOME? Mirrors `lib/config.ts::getConfigDir`. */
export function getCacheDir(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  if (xdg && xdg.length > 0) return join(xdg, "appstrate");
  return join(homedir(), ".cache", "appstrate");
}

/**
 * Build the two cache file paths for a given profile. They share the
 * same stem so a single `rm <profile>*` cleans them up in one shot.
 * The profile name is URL-encoded defensively — profile names with
 * path separators (`/`, `\`) would otherwise escape the cache
 * directory.
 */
function cachePaths(profileName: string): { json: string; etag: string } {
  const stem = `openapi-${encodeURIComponent(profileName)}`;
  const dir = getCacheDir();
  return { json: join(dir, `${stem}.json`), etag: join(dir, `${stem}.etag`) };
}

/**
 * Read the cached schema + ETag. Either file missing or unparseable is
 * treated as a miss (returns `null`) — the caller re-downloads. We do
 * NOT surface read errors other than "not found" because a corrupted
 * cache is never a fatal condition for exploration commands.
 */
async function readCache(
  profileName: string,
): Promise<{ doc: OpenApiDocument; etag?: string } | null> {
  const { json, etag } = cachePaths(profileName);
  let raw: string;
  try {
    raw = await readFile(json, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
  let parsed: OpenApiDocument;
  try {
    parsed = JSON.parse(raw) as OpenApiDocument;
  } catch {
    // Corrupted cache — treat as miss. The next fetch will overwrite it.
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  let etagValue: string | undefined;
  try {
    const raw = await readFile(etag, "utf-8");
    const trimmed = raw.trim();
    etagValue = trimmed.length > 0 ? trimmed : undefined;
  } catch {
    etagValue = undefined;
  }
  return { doc: parsed, etag: etagValue };
}

/**
 * Atomic write: same tmp+rename pattern as `writeConfig` in config.ts
 * so a Ctrl-C mid-save never leaves a torn JSON file on disk. The
 * ETag is written separately — a missing ETag with a present cache
 * file is handled gracefully above (skip `If-None-Match`).
 */
async function writeCache(
  profileName: string,
  doc: OpenApiDocument,
  etag: string | undefined,
): Promise<void> {
  const dir = getCacheDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const { json, etag: etagPath } = cachePaths(profileName);
  const tmpJson = `${json}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpJson, JSON.stringify(doc), { mode: 0o600 });
  try {
    await rename(tmpJson, json);
  } catch (err) {
    await unlink(tmpJson).catch(() => {});
    throw err;
  }
  if (etag === undefined) {
    // Server didn't provide an ETag — wipe any stale one so we don't
    // send a dangling `If-None-Match` next time and get a 304 whose
    // cached body no longer matches.
    await unlink(etagPath).catch(() => {});
    return;
  }
  const tmpEtag = `${etagPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpEtag, etag, { mode: 0o600 });
  try {
    await rename(tmpEtag, etagPath);
  } catch (err) {
    await unlink(tmpEtag).catch(() => {});
    throw err;
  }
}

/**
 * Remove the cached schema + ETag for a profile, if present. Exposed
 * for tests and for a future `appstrate openapi --clear-cache` flag.
 */
export async function clearCache(profileName: string): Promise<void> {
  const { json, etag } = cachePaths(profileName);
  await unlink(json).catch(() => {});
  await unlink(etag).catch(() => {});
}

/**
 * Fetch the OpenAPI schema for `profileName`, honoring the per-profile
 * ETag cache. Authenticated via `apiFetchRaw` so the request reuses
 * the profile's bearer + silent refresh + X-Org-Id wiring — the same
 * auth surface the rest of the CLI exposes.
 *
 * Returns the parsed JSON document. On non-2xx (other than 304) the
 * underlying response status is wrapped into an `Error` — the caller
 * funnels it through `formatError` / `exitWithError`.
 *
 * The `fetcher` parameter is a test seam: production code uses the
 * default (real `apiFetchRaw`), tests inject a stub that returns
 * controlled Response objects so we can cover hit / miss / 304 /
 * no-ETag / corruption / auth error paths without a live server.
 */
export interface OpenApiFetcher {
  (profileName: string, path: string, init: RequestInit): Promise<Response>;
}

const defaultFetcher: OpenApiFetcher = (profileName, path, init) =>
  apiFetchRaw(profileName, path, init as Parameters<typeof apiFetchRaw>[2]);

export async function fetchOpenApi(
  profileName: string,
  options: FetchOptions = {},
  fetcher: OpenApiFetcher = defaultFetcher,
): Promise<OpenApiDocument> {
  // `refresh` = skip read but keep write. `noCache` = skip both.
  const skipRead = options.noCache === true || options.refresh === true;
  const skipWrite = options.noCache === true;

  const cached = skipRead ? null : await readCache(profileName);
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (cached?.etag) {
    headers["If-None-Match"] = cached.etag;
  }

  const res = await fetcher(profileName, "/api/openapi.json", {
    method: "GET",
    headers,
  });

  if (res.status === 304) {
    // Revalidation succeeded — cached copy is still fresh. 304 is
    // impossible without a prior cache hit, but guard anyway so a
    // misbehaving server can't crash the CLI.
    if (!cached) {
      throw new Error(
        "Server responded 304 Not Modified but no cached schema is available. Re-run with --refresh.",
      );
    }
    return cached.doc;
  }

  if (res.status === 401) {
    throw new AuthError(
      `Unauthorized — your session may have been revoked. Run: appstrate login --profile ${profileName}`,
    );
  }

  if (!res.ok) {
    let body: string;
    try {
      body = await res.text();
    } catch {
      body = "";
    }
    throw new Error(
      `Failed to fetch OpenAPI schema: HTTP ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`,
    );
  }

  const etag = res.headers.get("etag") ?? undefined;
  let doc: OpenApiDocument;
  try {
    doc = (await res.json()) as OpenApiDocument;
  } catch (err) {
    throw new Error(
      `OpenAPI schema response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!doc || typeof doc !== "object") {
    throw new Error("OpenAPI schema response was empty or not an object.");
  }

  if (!skipWrite) {
    try {
      await writeCache(profileName, doc, etag);
    } catch {
      // Cache write failure is non-fatal — the user still gets their
      // result, just without the next-invocation speed-up. Silent on
      // purpose: the CLI's stderr is reserved for actionable errors.
    }
  }

  return doc;
}
