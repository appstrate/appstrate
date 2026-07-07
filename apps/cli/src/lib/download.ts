// SPDX-License-Identifier: Apache-2.0

/**
 * Streamed binary download with progress, a stall watchdog, and a hard
 * total-time backstop — shared by every large-asset fetch in the CLI
 * (`self-update` CLI binary, `runner install/update` daemon binary, and the
 * firecracker tarball).
 *
 * The problem it solves (issue #821): the previous downloads buffered the
 * whole response via `await res.arrayBuffer()` with no `AbortSignal` and no
 * progress. A 113 MB CLI binary or ~70 MB daemon was a silent multi-minute
 * gap in the terminal, and a stalled GitHub→CDN redirect would hang the
 * process forever with zero feedback.
 *
 * This helper instead:
 *   - streams the response body to disk chunk-by-chunk (peak memory ≈ one
 *     chunk + the SHA-256 hasher state, not the whole artifact);
 *   - computes the hex SHA-256 on the fly so the caller verifies without a
 *     second read;
 *   - reports byte/percent/rate progress (throttled) for a live spinner;
 *   - aborts with an actionable error if no bytes arrive for `stallTimeoutMs`
 *     (stall watchdog) or the whole transfer exceeds `totalTimeoutMs`;
 *   - never leaves a partial file behind — the destination is unlinked on any
 *     failure or abort.
 *
 * It is UI-free: callers wire `onProgress` to a spinner / log sink.
 */

import { rm } from "node:fs/promises";
import { formatBytes } from "@appstrate/core/format";

/** Progress tick. `total` is null when the server sent no `Content-Length`. */
export interface DownloadProgress {
  received: number;
  total: number | null;
  rateBytesPerSec: number;
}

export type ProgressFn = (p: DownloadProgress) => void;

/** The subset of `fetch` this helper uses — lets tests inject a plain function. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface StreamDownloadOptions {
  onProgress?: ProgressFn;
  /**
   * Abort if no bytes arrive for this many ms. This is the primary watchdog —
   * a slow-but-alive link is fine, a wedged redirect is not. Default 30_000.
   */
  stallTimeoutMs?: number;
  /** Hard ceiling on the whole transfer as a backstop. Default 20 minutes. */
  totalTimeoutMs?: number;
  headers?: Record<string, string>;
  /** Injected in tests; defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
}

export interface StreamDownloadResult {
  bytesWritten: number;
  /** Lowercase hex SHA-256 of the downloaded bytes. */
  sha256: string;
}

const DEFAULT_STALL_MS = 30_000;
const DEFAULT_TOTAL_MS = 20 * 60_000;
/** Never fire `onProgress` more than once per this interval (plus a final tick). */
const PROGRESS_THROTTLE_MS = 250;

/** Reason tags carried on the AbortController so the catch can explain itself. */
const STALL = Symbol("stall");
const TOTAL = Symbol("total");

/**
 * Download `url` to `destPath`, streaming to disk. Returns the byte count and
 * the on-the-fly SHA-256. Throws an actionable Error on a non-2xx status, a
 * stall, a total-timeout, or any network/disk failure — and removes a partial
 * `destPath` first.
 */
export async function streamDownload(
  url: string,
  destPath: string,
  opts: StreamDownloadOptions = {},
): Promise<StreamDownloadResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const stallMs = opts.stallTimeoutMs ?? DEFAULT_STALL_MS;
  const totalMs = opts.totalTimeoutMs ?? DEFAULT_TOTAL_MS;

  const controller = new AbortController();
  let abortKind: symbol | null = null;
  // A rejection that fires the moment a watchdog aborts. Racing it against
  // each `reader.read()` guarantees a prompt teardown even if the underlying
  // stream does not honour the fetch signal (some runtimes / injected fetches
  // do not) — the network signal is still passed so the socket tears down too.
  const makeAbortError = () => explainAbort(new Error("aborted"), abortKind, url, stallMs, totalMs);
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(makeAbortError()), { once: true });
  });
  // Swallow the terminal rejection so a resolved race never surfaces as an
  // unhandled promise rejection once the timers are cleared.
  aborted.catch(() => {});

  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  const armStall = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      abortKind = STALL;
      controller.abort();
    }, stallMs);
  };
  const totalTimer = setTimeout(() => {
    abortKind = TOTAL;
    controller.abort();
  }, totalMs);

  const hasher = new Bun.CryptoHasher("sha256");
  // Opened lazily AFTER the response is validated so an early throw (non-2xx,
  // stall before headers) never leaves an empty file at `destPath`.
  let sink: ReturnType<ReturnType<typeof Bun.file>["writer"]> | null = null;
  let received = 0;
  const startedAt = Date.now();
  let lastTick = 0;
  const emit = (force: boolean, total: number | null) => {
    if (!opts.onProgress) return;
    const now = Date.now();
    if (!force && now - lastTick < PROGRESS_THROTTLE_MS) return;
    lastTick = now;
    const elapsed = Math.max(1, now - startedAt) / 1000;
    opts.onProgress({ received, total, rateBytesPerSec: received / elapsed });
  };

  try {
    armStall();
    const res = await Promise.race([
      fetchImpl(url, { redirect: "follow", headers: opts.headers, signal: controller.signal }),
      aborted,
    ]);
    if (!res.ok) {
      // Keep the `HTTP <status>` shape — callers regex it (e.g. the runner's
      // asRunnerAssetError turns a 404 into a "release shipped no runner
      // assets" hint).
      throw new Error(
        `GET ${url} → HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`,
      );
    }
    const lenHeader = res.headers.get("content-length");
    const total = lenHeader && /^\d+$/.test(lenHeader) ? Number(lenHeader) : null;
    if (!res.body) {
      throw new Error(`GET ${url} → empty response body`);
    }

    sink = Bun.file(destPath).writer();
    const reader = res.body.getReader();
    armStall();
    try {
      for (;;) {
        const chunk = await Promise.race([reader.read(), aborted]);
        if (chunk.done) break;
        armStall();
        const bytes = chunk.value;
        hasher.update(bytes);
        sink.write(bytes);
        received += bytes.byteLength;
        emit(false, total);
      }
    } catch (err) {
      await reader.cancel().catch(() => {});
      throw err;
    } finally {
      reader.releaseLock?.();
    }
    emit(true, total);
    await sink.end();
    sink = null; // successfully flushed; do not unlink below

    return { bytesWritten: received, sha256: hasher.digest("hex") };
  } catch (err) {
    // Flush/close the sink best-effort, then remove any file we opened so a
    // retry or the caller's verification never sees a truncated artifact.
    if (sink) {
      try {
        await sink.end();
      } catch {
        /* ignore */
      }
      await rm(destPath, { force: true }).catch(() => {});
    }
    throw err;
  } finally {
    clearTimeout(stallTimer);
    clearTimeout(totalTimer);
  }
}

/** Map a raw fetch/read rejection to an actionable message when we aborted it. */
function explainAbort(
  err: unknown,
  kind: symbol | null,
  url: string,
  stallMs: number,
  totalMs: number,
): Error {
  if (kind === STALL) {
    return new Error(
      `Download stalled: no data from ${url} for ${Math.round(stallMs / 1000)}s. ` +
        `The connection wedged (often a slow/broken GitHub→CDN redirect). ` +
        `Check the host's network and retry.`,
    );
  }
  if (kind === TOTAL) {
    return new Error(
      `Download timed out after ${Math.round(totalMs / 60_000)} min (${url}). ` +
        `The link is too slow to complete; retry on a better connection.`,
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Format a progress tick for a spinner line, e.g.
 * `42.1 MB / 113 MB (37%) · 4.2 MB/s`. Percent is omitted when the total is
 * unknown (no Content-Length behind a CDN). Byte magnitudes use the shared
 * `@appstrate/core/format` formatter.
 */
export function formatProgress(p: DownloadProgress): string {
  const rate = `${formatBytes(p.rateBytesPerSec)}/s`;
  if (p.total && p.total > 0) {
    const pct = Math.min(100, Math.floor((p.received / p.total) * 100));
    return `${formatBytes(p.received)} / ${formatBytes(p.total)} (${pct}%) · ${rate}`;
  }
  return `${formatBytes(p.received)} · ${rate}`;
}
