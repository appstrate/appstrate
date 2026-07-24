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
import type { RunArtifactsSummary } from "@appstrate/afps-runtime/runner";

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

/**
 * Stable, machine-readable classification of an abandoned document upload,
 * carried on {@link UploadError.code} so the sweep records WHY a deliverable was
 * lost without parsing a human message:
 *   - `file_too_large`  — server 413 (over the per-file / per-run cap).
 *   - `quota_exceeded`  — server 403 (org storage quota; `storage_limit_exceeded`).
 *   - `conflict`        — server 409 (run not running — published after finalize).
 *   - `upload_failed`   — network error / timeout / 5xx / 429 exhausted after retries.
 */
export type UploadFailureCode = "file_too_large" | "quota_exceeded" | "conflict" | "upload_failed";

/**
 * A document upload the uploader definitively abandoned. Carries a typed
 * {@link UploadFailureCode} so the sweep (and the artifacts summary) can report
 * the failure category, not just a string. Extends `Error` so the
 * `publish_document` tool keeps surfacing `.message` unchanged.
 */
export class UploadError extends Error {
  readonly code: UploadFailureCode;
  constructor(code: UploadFailureCode, message: string) {
    super(message);
    this.name = "UploadError";
    this.code = code;
  }
}

/**
 * Map a definitive (non-retryable) HTTP status to a typed failure code. The
 * document endpoint's 4xx vocabulary is narrow: 413 cap, 403 org quota, 409
 * run-not-running; anything else (401 signature, unexpected 4xx) is a generic
 * `upload_failed`.
 */
function classifyHttpFailure(status: number): UploadFailureCode {
  if (status === 413) return "file_too_large";
  if (status === 403) return "quota_exceeded";
  if (status === 409) return "conflict";
  return "upload_failed";
}

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
   * Dedup identities already published by this run, keyed `${sha256}:${name}` to
   * MATCH the server dedup identity `(runId, sha256, name)` (the partial unique
   * index `uq_documents_run_output_dedup`). Every successful upload records its
   * key here so the outputs sweep can skip a file the `publish_document` tool
   * (or a prior sweep entry) already stored — while two files with identical
   * bytes but DIFFERENT names still BOTH publish (distinct keys). Shared between
   * the tool + sweep.
   */
  publishedKeys: Set<string>;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchFn?: typeof fetch;
  /** Injected for tests to skip real backoff waits; defaults to `setTimeout`. */
  sleepFn?: (ms: number) => Promise<void>;
}

/**
 * Build the `uploadRunDocument(path, name?)` function the `publish_document`
 * tool and the outputs sweep both call. It streams the file straight to
 * `POST /api/runs/:id/documents` (never buffering it), records the returned
 * `${sha256}:${name}` identity in {@link RunDocumentUploaderDeps.publishedKeys},
 * and returns the durable document metadata. Retryable failures (network error,
 * per-attempt timeout, 5xx, 429 — honouring `Retry-After`) are retried up to
 * {@link MAX_UPLOAD_ATTEMPTS} times with jittered backoff; a definitive 4xx
 * (413/409/401/403) fails fast. Throws a typed {@link UploadError} (with a
 * {@link UploadFailureCode}) on an abandoned upload — and a plain `Error` on a
 * missing file or a path resolving outside the workspace — so the tool surfaces
 * it as a tool error and the sweep records the failure category.
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
        // Record the server-authoritative identity (its sanitized name +
        // sha256), matching the server dedup index exactly.
        deps.publishedKeys.add(`${doc.sha256}:${doc.name}`);
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
        throw new UploadError(
          classifyHttpFailure(res.status),
          `upload of '${relPath}' failed — ${detail}`,
        );
      }
      if (attempt >= MAX_UPLOAD_ATTEMPTS) break;
      // Honour `Retry-After` on 429 when present, else jittered backoff.
      const retryAfterMs =
        res.status === 429 ? parseRetryAfterMs(res.headers.get("retry-after")) : undefined;
      await sleep(retryAfterMs ?? backoffMs(attempt));
    }

    // Retries exhausted (network error / timeout / 5xx / 429) — the deliverable
    // is abandoned. `upload_failed` is the catch-all category for a transient
    // fault that never resolved.
    throw new UploadError(
      "upload_failed",
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
  publishedKeys: Set<string>;
  /** Per-file ceiling; files above it are skipped with a warning (server also caps). */
  maxFileBytes: number;
  /** Emits the canonical `document.published` event for each swept file. */
  emit: (event: { type: "document.published"; [k: string]: unknown }) => void | Promise<void>;
  /** Structured warning logger (non-fatal — the sweep never blocks finalize). */
  logWarn?: (message: string, data?: Record<string, unknown>) => void;
}

/**
 * Why the sweep did NOT publish a scanned entry. All are NON-fatal:
 *   - `already_published` — its `${sha}:${name}` key was already stored.
 *   - `hidden`            — a dotfile / file under a hidden dir (never swept).
 *   - `symlink`           — a symlink (never followed).
 *   - `oversized`         — over the per-file cap. A LOST deliverable — the
 *     artifacts summary promotes it to a `file_too_large` failure.
 *   - `empty_dir_or_other`— a directory or other non-regular entry (readdir
 *     yields intermediate dirs); nothing to publish.
 */
export type SweepSkipReason =
  "already_published" | "hidden" | "symlink" | "oversized" | "empty_dir_or_other";

/**
 * Structured outcome of a {@link sweepOutputs} pass. `published` is what reached
 * durable storage; `skipped` is the (mostly benign) non-publishes with a reason;
 * `failed` is the deliverables the uploader definitively ABANDONED after retries,
 * each with a typed {@link UploadFailureCode}. `name` is the workspace-relative
 * path under `outputs/` (the deterministic per-file identity — see
 * {@link sweepOutputs} for the basename-vs-path naming note).
 */
export interface SweepResult {
  published: Array<{ name: string; sha256: string; size: number }>;
  skipped: Array<{ name: string; reason: SweepSkipReason }>;
  failed: Array<{ name: string; code: UploadFailureCode; message: string }>;
}

/** Max files uploaded concurrently by a single sweep — bounds container egress. */
const SWEEP_CONCURRENCY = 3;

/**
 * Auto-publish every file the agent wrote under `workspace/outputs/` that was
 * not already published by this run. Runs after the agent session ends but
 * BEFORE the finalize event, so the published documents surface as run events.
 *
 * Bounded: a file larger than `maxFileBytes` is recorded as `oversized`
 * (a LOST deliverable — see {@link summarizeArtifacts}); a file whose
 * `${sha}:${name}` key is already in `publishedKeys` (the `publish_document`
 * tool already stored it) is `already_published`. Per-file upload errors are
 * COLLECTED into {@link SweepResult.failed} — never swallowed — so the caller
 * can report which deliverables were dropped, yet a single failure still never
 * blocks or fails the run's finalize.
 *
 * Naming: the published document `name` is `path.basename(rel)` — the sweep
 * deliberately FLATTENS the relative path and does NOT recreate the folder
 * structure server-side. Two files with the same basename but DIFFERENT content
 * both publish (different sha256 → different `(sha, name)` identity). Two files
 * with the same basename AND identical content (e.g. `a/report.md` and
 * `b/report.md` byte-for-byte) collapse to ONE document — identical bytes under
 * the same name are the same deliverable by the server's dedup identity. This
 * is intentional and deterministic; the `SweepResult` still lists each source
 * path under its own `name` (the workspace-relative `rel`) so reporting stays
 * per-file.
 */
export async function sweepOutputs(deps: SweepOutputsDeps): Promise<SweepResult> {
  const result: SweepResult = { published: [], skipped: [], failed: [] };
  const outputsDir = path.join(deps.workspace, "outputs");
  let entries: string[];
  try {
    entries = await fs.readdir(outputsDir, { recursive: true });
  } catch {
    // No `outputs/` directory — the common case, not an error.
    return result;
  }

  const publishEntry = async (rel: string): Promise<void> => {
    const abs = path.join(outputsDir, rel);
    // Skip hidden files by default: any path segment starting with `.`
    // (a dotfile like `.env`/`.netrc`, or anything under a hidden dir like
    // `.git/`). The implicit sweep must not exfiltrate these as org-visible
    // documents — only the explicit `publish_document` tool may publish them.
    if (rel.split(path.sep).some((seg) => seg.startsWith("."))) {
      deps.logWarn?.("outputs sweep skipped hidden file", { file: rel });
      result.skipped.push({ name: rel, reason: "hidden" });
      return;
    }
    // `lstat` (not `stat`) so a symlink is not followed: its target could sit
    // outside the workspace, and the uploader would refuse it anyway. Skip it
    // here with a warning rather than let it reach the uploader as a per-file
    // error.
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(abs);
    } catch (err) {
      // Vanished between readdir and lstat, or unreadable — treat as a dropped
      // deliverable so it is visible, not silently gone.
      result.failed.push({ name: rel, code: "upload_failed", message: getErrorMessage(err) });
      deps.logWarn?.("outputs sweep could not stat a deliverable", {
        file: rel,
        error: getErrorMessage(err),
      });
      return;
    }
    if (stat.isSymbolicLink()) {
      deps.logWarn?.("outputs sweep skipped symlink", { file: rel });
      result.skipped.push({ name: rel, reason: "symlink" });
      return;
    }
    if (!stat.isFile()) {
      // Intermediate directory (recursive readdir lists them) or other
      // non-regular entry — nothing to publish, not a failure.
      result.skipped.push({ name: rel, reason: "empty_dir_or_other" });
      return;
    }
    if (stat.size > deps.maxFileBytes) {
      deps.logWarn?.("outputs sweep skipped oversized file", {
        file: rel,
        size: stat.size,
        maxFileBytes: deps.maxFileBytes,
      });
      result.skipped.push({ name: rel, reason: "oversized" });
      return;
    }

    const sha = await fileSha256(abs);
    const documentName = path.basename(rel);
    const key = `${sha}:${documentName}`;
    if (deps.publishedKeys.has(key)) {
      // Already published by this run (the `publish_document` tool or a prior
      // sweep entry with the same content + name).
      result.skipped.push({ name: rel, reason: "already_published" });
      return;
    }
    // Reserve the key before the async upload: with SWEEP_CONCURRENCY > 1, two
    // identical-content+same-name files would otherwise both pass the check
    // above and publish twice. Rolled back on failure so a dropped file is not
    // remembered as published.
    deps.publishedKeys.add(key);
    try {
      const doc = await deps.uploader(path.join("outputs", rel), documentName);
      await deps.emit(documentPublishedEvent(doc));
      result.published.push({ name: rel, sha256: doc.sha256, size: doc.size });
    } catch (err) {
      deps.publishedKeys.delete(key);
      // Best-effort: a single file's failure must not abort the sweep or the
      // run. The uploader has exhausted its retries, so this deliverable is
      // DROPPED — COLLECT it (name + typed code + last error) instead of
      // swallowing, so finalize can report the loss.
      const code: UploadFailureCode = err instanceof UploadError ? err.code : "upload_failed";
      result.failed.push({ name: rel, code, message: getErrorMessage(err) });
      deps.logWarn?.("outputs sweep dropped a deliverable (upload failed)", {
        file: rel,
        code,
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
  return result;
}

/**
 * Bounds on the terminal artifacts summary, matching the server's tolerant
 * ingest contract in `apps/api/src/routes/runs-events.ts` (RunResultSchema
 * `artifacts`): the server clamps `failed` to {@link MAX_ARTIFACTS_FAILED}
 * entries and each `name`/`code` string to these lengths. The producer applies
 * the SAME bounds here so a container with thousands of dropped deliverables
 * never emits a summary the server has to truncate — the wire payload stays
 * small and the two sides agree byte-for-byte.
 */
const MAX_ARTIFACTS_FAILED = 1000;
const MAX_ARTIFACT_NAME_LEN = 512;
const MAX_ARTIFACT_CODE_LEN = 64;

/**
 * Reduce a {@link SweepResult} to the terminal artifacts summary persisted on
 * the run row. `failed` combines the abandoned uploads with the `oversized`
 * skips (a deliverable dropped for exceeding the per-file cap is a LOSS, mapped
 * to `file_too_large`); the other skip reasons (`already_published`, `hidden`,
 * `symlink`, `empty_dir_or_other`) are NORMAL and excluded. `status` is
 * `"partial"` exactly when at least one deliverable was lost.
 *
 * Bounded to the server's ingest contract (see the constants above): `failed`
 * is sliced to {@link MAX_ARTIFACTS_FAILED} and each `name`/`code` truncated, so
 * an unbounded loss list can never bloat the finalize payload. The `status` /
 * `published` counts reflect the FULL result — only the enumerated `failed`
 * list is capped.
 */
export function summarizeArtifacts(result: SweepResult): RunArtifactsSummary {
  const failedAll: Array<{ name: string; code: string }> = [
    ...result.failed.map((f) => ({ name: f.name, code: f.code })),
    ...result.skipped
      .filter((s) => s.reason === "oversized")
      .map((s) => ({ name: s.name, code: "file_too_large" })),
  ];
  const failed = failedAll.slice(0, MAX_ARTIFACTS_FAILED).map((f) => ({
    name: f.name.slice(0, MAX_ARTIFACT_NAME_LEN),
    code: f.code.slice(0, MAX_ARTIFACT_CODE_LEN),
  }));
  return {
    status: failedAll.length > 0 ? "partial" : "complete",
    published: result.published.length,
    failed,
  };
}
