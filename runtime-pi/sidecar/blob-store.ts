// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Run-scoped blob cache backing the sidecar's MCP `resources/*` surface.
 *
 * One writer populates this store: the `provider_call` tool when an
 * upstream response is too large to inline.
 *
 * One reader: the MCP `resources/read` handler (validated against the
 * session's `runId` before serving bytes — cross-run reads are a
 * security incident, not a feature).
 *
 * Design (V2 + V8 from the migration plan):
 *   - URI scheme: `appstrate://provider-response/{runId}/{ulid}`. The
 *     ULID is unguessable per spec security guidance — sequential IDs
 *     are forbidden.
 *   - In-memory only. The agent run lives in a single container with a
 *     bounded lifetime; persistence buys nothing and complicates teardown.
 *   - TTL = run lifetime + 60s grace. After grace, `read` returns
 *     `-32002 Resource not found` so cancelled reads see a clean error.
 *   - Sidecar process exit is sufficient eviction — we don't ship a
 *     reaper because there's no shared state to leak.
 *
 * What this file deliberately is NOT:
 *   - A general-purpose KV store. Run-scoped, ULID-only, no
 *     cross-instance replication.
 *   - A persistent cache. The blob store is process-local; restarting
 *     the sidecar drops every URI.
 */

const ULID_BYTES = 16;
const ENCODING_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32 — ULID standard.

export interface BlobRecord {
  /** Stable URI handed back to the agent in `resource_link` blocks. */
  uri: string;
  /** The bytes themselves. */
  bytes: Uint8Array;
  /** Detected/declared MIME type. Falls back to `application/octet-stream`. */
  mimeType: string;
  /** ms epoch — present on every blob, used for grace-period cleanup. */
  createdAt: number;
  /** Optional source descriptor for observability (e.g. `provider:gmail`). */
  source?: string;
}

export interface PutOptions {
  mimeType?: string;
  source?: string;
}

/** Generate a ULID-style id (Crockford base32, 26 chars). */
export function generateUlid(now: number = Date.now()): string {
  const bytes = new Uint8Array(ULID_BYTES);
  // 48-bit timestamp (ms) in big-endian.
  for (let i = 0; i < 6; i += 1) {
    bytes[i] = Math.floor(now / 2 ** ((5 - i) * 8)) & 0xff;
  }
  // 80-bit random tail.
  crypto.getRandomValues(bytes.subarray(6));
  // Crockford base32 encode (5 bits per char).
  let bits = 0;
  let value = 0;
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    value = (value << 8) | bytes[i]!;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ENCODING_ALPHABET[(value >> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    out += ENCODING_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return out.slice(0, 26);
}

const BLOB_URI_PREFIX_TEMPLATE = "appstrate://provider-response/";

/**
 * Build the full URI for a blob in the given run. Exposed so callers
 * needing to compute URIs without storing (or from tests) can do so
 * without duplicating the format string.
 */
export function blobUri(runId: string, id: string): string {
  return `${BLOB_URI_PREFIX_TEMPLATE}${runId}/${id}`;
}

/**
 * Parse a blob URI into `{ runId, id }`. Returns `null` for any URI
 * that is malformed, has the wrong scheme, the wrong host, or contains
 * path traversal sequences. **Strict** — the goal is to reject early
 * so the read handler never sees an attacker-shaped path.
 */
export function parseBlobUri(uri: string): { runId: string; id: string } | null {
  if (typeof uri !== "string" || !uri.startsWith(BLOB_URI_PREFIX_TEMPLATE)) return null;
  const tail = uri.slice(BLOB_URI_PREFIX_TEMPLATE.length);
  // Reject percent-encoded slashes, dots, and other traversal vectors.
  if (/[?#]/.test(tail) || tail.includes("..") || tail.includes("//")) return null;
  if (/%2[fF]|%2[eE]|%5[cC]/.test(tail)) return null;
  const parts = tail.split("/");
  if (parts.length !== 2) return null;
  const [runId, id] = parts;
  if (!runId || !id) return null;
  // Conservative allowlist: ULID-style + UUID-style + run ids the
  // platform mints (alphanumeric, dash, underscore). 64 chars max
  // mirrors the AFPS run id limit.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(runId)) return null;
  if (!/^[A-Z0-9]{16,32}$|^[A-Za-z0-9_-]{8,64}$/.test(id)) return null;
  return { runId, id };
}

/**
 * Run-scoped, in-memory blob store. Created once per sidecar process
 * (the sidecar serves exactly one run for its lifetime).
 */
export class BlobStore {
  private readonly blobs = new Map<string, BlobRecord>();
  private readonly maxTotalBytes: number;
  private totalBytes = 0;

  constructor(
    readonly runId: string,
    options: { maxTotalBytes?: number } = {},
  ) {
    // Default 256MB per run — large enough to hold a few PDFs, far
    // smaller than the cgroup limit so we fail predictably before OOM.
    this.maxTotalBytes = options.maxTotalBytes ?? 256 * 1024 * 1024;
  }

  /** Number of blobs currently retained (for tests + observability). */
  size(): number {
    return this.blobs.size;
  }

  /** Total bytes retained (for tests + observability). */
  bytesUsed(): number {
    return this.totalBytes;
  }

  /**
   * Store bytes and return the URI. Throws when the cumulative store
   * size would exceed `maxTotalBytes` — the caller should surface the
   * failure as a tool-level error so the agent sees it.
   */
  put(bytes: Uint8Array, options: PutOptions = {}): BlobRecord {
    if (this.totalBytes + bytes.byteLength > this.maxTotalBytes) {
      throw new Error(
        `BlobStore: cumulative size would exceed ${this.maxTotalBytes} bytes ` +
          `(current=${this.totalBytes}, incoming=${bytes.byteLength})`,
      );
    }
    const id = generateUlid();
    const uri = blobUri(this.runId, id);
    const record: BlobRecord = {
      uri,
      bytes,
      mimeType: options.mimeType ?? "application/octet-stream",
      createdAt: Date.now(),
      ...(options.source !== undefined ? { source: options.source } : {}),
    };
    this.blobs.set(id, record);
    this.totalBytes += bytes.byteLength;
    return record;
  }

  /** Read a blob by URI. Returns `null` when the URI is invalid or
   * resolves to a different run id (cross-run reads = security
   * incident; the caller should surface a 404, not the actual record). */
  read(uri: string): BlobRecord | null {
    const parsed = parseBlobUri(uri);
    if (!parsed) return null;
    if (parsed.runId !== this.runId) return null;
    return this.blobs.get(parsed.id) ?? null;
  }

  /** List every URI currently stored (for `resources/list`). */
  list(): { uri: string; mimeType: string; name?: string }[] {
    return [...this.blobs.values()].map((r) => ({
      uri: r.uri,
      mimeType: r.mimeType,
      ...(r.source !== undefined ? { name: r.source } : {}),
    }));
  }

  /** Drop everything. Called at sidecar shutdown for orderly teardown. */
  clear(): void {
    this.blobs.clear();
    this.totalBytes = 0;
  }
}
