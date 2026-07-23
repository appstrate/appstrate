// SPDX-License-Identifier: Apache-2.0

/**
 * Agent-container document publishing — the run→platform outbound channel.
 *
 * Two consumers share this module:
 *   - the `publish_document` runtime tool, which calls {@link createRunDocumentUploader}
 *     to upload a single workspace file the agent chose to publish; and
 *   - the end-of-run {@link sweepOutputs} pass, which auto-publishes every file
 *     the agent wrote under `workspace/outputs/`.
 *
 * Extracted from `entrypoint.ts` (a top-level-`await` script with `process.exit`
 * side effects, so it can't be imported) exactly like `provision.ts`, so the
 * signing + streaming + dedup paths are unit-testable against a local server.
 *
 * Auth mirrors the workspace/documents GET provisioning fetches: a Standard
 * Webhooks HMAC over an EMPTY body keyed on the run secret. The document bytes
 * are not part of the signature (they stream, unbuffered) — the run secret
 * proves the caller is the run, the server returns the sha256 for integrity.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { sign } from "@appstrate/afps-runtime/events";
import { resolveWorkspaceFile } from "@appstrate/afps-runtime/resolvers";
import { getErrorMessage } from "@appstrate/core/errors";
import { documentPublishedEvent } from "@appstrate/core/runtime-tool-defs";
import type { PublishedDocument } from "@appstrate/core/runtime-tool-defs";

/** Minimal Content-Type inference from a file extension. */
const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".xml": "application/xml",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".zip": "application/zip",
};

function guessMime(filePath: string): string {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/** Total upload attempts (1 initial + 2 retries) before a file is abandoned. */
const MAX_UPLOAD_ATTEMPTS = 3;
/** Base backoff between retries; doubled per attempt, plus small jitter. */
const RETRY_BASE_MS = 250;
/** Fixed slice of the per-attempt timeout — covers connect + server processing. */
const UPLOAD_TIMEOUT_BASE_MS = 30_000;
/** Pessimistic floor throughput used to size the timeout from the file size. */
const UPLOAD_TIMEOUT_FLOOR_BYTES_PER_SEC = 1024 * 1024; // 1 MiB/s

/**
 * Per-attempt upload timeout: a fixed base (connect + server processing) plus
 * time for the bytes at a deliberately pessimistic floor throughput, so a large
 * but healthy upload is never cut short while a truly stuck socket still aborts.
 * Pure function of the byte count so it is trivially unit-testable.
 */
export function uploadTimeoutMs(fileBytes: number): number {
  const bytes = Math.max(0, fileBytes);
  return UPLOAD_TIMEOUT_BASE_MS + Math.ceil((bytes / UPLOAD_TIMEOUT_FLOOR_BYTES_PER_SEC) * 1000);
}

/** Jittered exponential backoff for retry attempt `n` (1-based). */
function backoffMs(attempt: number): number {
  return RETRY_BASE_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * RETRY_BASE_MS);
}

/** Ceiling on an honoured `Retry-After` — a huge (or hostile) value must not stall finalize. */
const RETRY_AFTER_CAP_MS = 30_000;

/** Parse a `Retry-After` header (delta-seconds or HTTP-date) to milliseconds, capped. */
function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, RETRY_AFTER_CAP_MS);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.min(Math.max(0, date - Date.now()), RETRY_AFTER_CAP_MS);
  return undefined;
}

export interface RunDocumentUploaderDeps {
  /** The run-scoped event sink URL (`…/api/runs/:id/events`). `/events` is swapped for `/documents`. */
  sinkUrl: string;
  /** Run secret used to HMAC-sign each POST (Standard Webhooks, empty body). */
  sinkSecret: string;
  /** Absolute workspace root; upload paths are resolved relative to it. */
  workspace: string;
  /**
   * sha256s already published by this run — every successful upload records its
   * sha here so the outputs sweep can skip a file the `publish_document` tool
   * (or a prior sweep entry) already stored. Shared between the tool + sweep.
   */
  publishedShas: Set<string>;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchFn?: typeof fetch;
  /** Injected for tests to skip real backoff waits; defaults to `setTimeout`. */
  sleepFn?: (ms: number) => Promise<void>;
}

/**
 * Build the `uploadRunDocument(path, name?)` function the `publish_document`
 * tool and the outputs sweep both call. It streams the file straight to
 * `POST /api/runs/:id/documents` (never buffering it), records the returned
 * sha256 in {@link RunDocumentUploaderDeps.publishedShas}, and returns the
 * durable document metadata. Retryable failures (network error, per-attempt
 * timeout, 5xx, 429 — honouring `Retry-After`) are retried up to
 * {@link MAX_UPLOAD_ATTEMPTS} times with jittered backoff; a definitive 4xx
 * (413/409/401/403) fails fast. Throws a clear `Error` on a missing file, a
 * path resolving outside the workspace (through symlinks or not), or an
 * abandoned upload so the tool surfaces it as a tool error.
 */
export function createRunDocumentUploader(
  deps: RunDocumentUploaderDeps,
): (relPath: string, name?: string) => Promise<PublishedDocument> {
  const fetchFn = deps.fetchFn ?? fetch;
  const sleep = deps.sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const url = deps.sinkUrl.replace(/\/events$/, "/documents");

  return async (relPath, name) => {
    // `publish_document` promises a workspace-relative path. Keep that
    // contract narrower than api_call/api_upload: absolute `/tmp` paths are
    // not publishable, and symlinks may not escape the workspace.
    const { absPath } = await resolveWorkspaceFile(deps.workspace, relPath);
    const documentName = name ?? path.basename(absPath);
    const contentType = guessMime(absPath);
    // Size the per-attempt timeout from the payload once — the file is not
    // re-read between attempts (the body stream is rebuilt each try).
    const timeoutMs = uploadTimeoutMs(Bun.file(absPath).size);

    // Retry loop: 3 attempts on retryable failures (network error, timeout,
    // 5xx, 429). Definitive 4xx (413 payload cap, 409 run-not-running, 401/403)
    // throw immediately — a retry cannot change the outcome. `lastError` carries
    // the most recent failure into the abandonment message.
    let lastError = "";
    for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt++) {
      const headers: Record<string, string> = {
        ...sign({
          msgId: randomUUID(),
          timestampSec: Math.floor(Date.now() / 1000),
          body: "",
          secret: deps.sinkSecret,
        }),
        "Content-Type": contentType,
        "X-Document-Name": documentName,
      };

      let res: Response;
      try {
        res = await fetchFn(url, {
          method: "POST",
          headers,
          body: Bun.file(absPath).stream(),
          // Streaming a request body requires the half-duplex opt-in.
          duplex: "half",
          // A timed-out attempt aborts (TimeoutError) and counts as retryable.
          signal: AbortSignal.timeout(timeoutMs),
        } as RequestInit & { duplex: "half" });
      } catch (err) {
        // Network failure or timeout — retryable.
        lastError = getErrorMessage(err);
        if (attempt < MAX_UPLOAD_ATTEMPTS) {
          await sleep(backoffMs(attempt));
          continue;
        }
        break;
      }

      if (res.ok) {
        const doc = (await res.json()) as PublishedDocument;
        deps.publishedShas.add(doc.sha256);
        return doc;
      }

      let detail = `HTTP ${res.status}`;
      try {
        const text = await res.text();
        if (text) detail = `HTTP ${res.status}: ${text}`;
      } catch {
        // ignore — status alone is enough
      }
      lastError = detail;

      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable) {
        throw new Error(`upload of '${relPath}' failed — ${detail}`);
      }
      if (attempt >= MAX_UPLOAD_ATTEMPTS) break;
      // Honour `Retry-After` on 429 when present, else jittered backoff.
      const retryAfterMs =
        res.status === 429 ? parseRetryAfterMs(res.headers.get("retry-after")) : undefined;
      await sleep(retryAfterMs ?? backoffMs(attempt));
    }

    throw new Error(
      `upload of '${relPath}' failed after ${MAX_UPLOAD_ATTEMPTS} attempts — ${lastError}`,
    );
  };
}

/** Compute a file's sha256 by streaming it (bounded memory). */
async function fileSha256(abs: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  const stream = Bun.file(abs).stream();
  for await (const chunk of stream) hasher.update(chunk);
  return hasher.digest("hex");
}

export interface SweepOutputsDeps {
  /** The uploader from {@link createRunDocumentUploader}. */
  uploader: (relPath: string, name?: string) => Promise<PublishedDocument>;
  /** Absolute workspace root — the sweep scans `<workspace>/outputs/`. */
  workspace: string;
  /** Shared dedup set (same instance handed to the uploader). */
  publishedShas: Set<string>;
  /** Per-file ceiling; files above it are skipped with a warning (server also caps). */
  maxFileBytes: number;
  /** Emits the canonical `document.published` event for each swept file. */
  emit: (event: { type: "document.published"; [k: string]: unknown }) => void | Promise<void>;
  /** Structured warning logger (non-fatal — the sweep never blocks finalize). */
  logWarn?: (message: string, data?: Record<string, unknown>) => void;
}

/** Max files uploaded concurrently by a single sweep — bounds container egress. */
const SWEEP_CONCURRENCY = 3;

/**
 * Auto-publish every file the agent wrote under `workspace/outputs/` that was
 * not already published by this run. Runs after the agent session ends but
 * BEFORE the finalize event, so the published documents surface as run events.
 *
 * Bounded: a file larger than `maxFileBytes` is skipped with a warning; a file
 * whose sha256 is already in `publishedShas` (the `publish_document` tool
 * already stored it) is skipped. Every failure — a missing `outputs/` dir, a
 * per-file upload error — is logged and swallowed: the sweep must never block
 * or fail the run's finalize.
 */
export async function sweepOutputs(deps: SweepOutputsDeps): Promise<void> {
  const outputsDir = path.join(deps.workspace, "outputs");
  let entries: string[];
  try {
    entries = await fs.readdir(outputsDir, { recursive: true });
  } catch {
    // No `outputs/` directory — the common case, not an error.
    return;
  }

  const publishEntry = async (rel: string): Promise<void> => {
    const abs = path.join(outputsDir, rel);
    try {
      // Skip hidden files by default: any path segment starting with `.`
      // (a dotfile like `.env`/`.netrc`, or anything under a hidden dir like
      // `.git/`). The implicit sweep must not exfiltrate these as org-visible
      // documents — only the explicit `publish_document` tool may publish them.
      if (rel.split(path.sep).some((seg) => seg.startsWith("."))) {
        deps.logWarn?.("outputs sweep skipped hidden file", { file: rel });
        return;
      }
      // `lstat` (not `stat`) so a symlink is not followed: its target could sit
      // outside the workspace, and the uploader would refuse it anyway. Skip it
      // here with a warning rather than let it reach the uploader as a per-file
      // error.
      const stat = await fs.lstat(abs);
      if (stat.isSymbolicLink()) {
        deps.logWarn?.("outputs sweep skipped symlink", { file: rel });
        return;
      }
      if (!stat.isFile()) return;
      if (stat.size > deps.maxFileBytes) {
        deps.logWarn?.("outputs sweep skipped oversized file", {
          file: rel,
          size: stat.size,
          maxFileBytes: deps.maxFileBytes,
        });
        return;
      }
      const sha = await fileSha256(abs);
      if (deps.publishedShas.has(sha)) return; // already published by this run
      // Reserve the sha before the async upload: with SWEEP_CONCURRENCY > 1,
      // two same-content files would otherwise both pass the check above and
      // publish twice. Rolled back on failure so a dropped file is not
      // remembered as published.
      deps.publishedShas.add(sha);
      try {
        const doc = await deps.uploader(path.join("outputs", rel), path.basename(rel));
        await deps.emit(documentPublishedEvent(doc));
      } catch (err) {
        deps.publishedShas.delete(sha);
        throw err;
      }
    } catch (err) {
      // Best-effort: a single file's failure must not abort the sweep or the
      // run. The uploader has already exhausted its retries, so this deliverable
      // is DROPPED — surface it clearly (name + last error/attempt count).
      deps.logWarn?.("outputs sweep dropped a deliverable (upload failed)", {
        file: rel,
        error: getErrorMessage(err),
      });
    }
  };

  // Bounded worker pool: publish up to SWEEP_CONCURRENCY files at once. A shared
  // cursor hands each worker the next entry; each entry is self-contained
  // (own try/catch), so one failure never stalls the pool.
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < entries.length) {
      const rel = entries[cursor++]!;
      await publishEntry(rel);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(SWEEP_CONCURRENCY, entries.length) }, () => worker()),
  );
}
