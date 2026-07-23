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
import { resolveSafeFile } from "@appstrate/afps-runtime/resolvers";
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
}

/**
 * Build the `uploadRunDocument(path, name?)` function the `publish_document`
 * tool and the outputs sweep both call. It streams the file straight to
 * `POST /api/runs/:id/documents` (never buffering it), records the returned
 * sha256 in {@link RunDocumentUploaderDeps.publishedShas}, and returns the
 * durable document metadata. Throws a clear `Error` on a missing file, a path
 * resolving outside the allowed roots (through symlinks or not), or a non-2xx
 * response so the tool surfaces it as a tool error.
 */
export function createRunDocumentUploader(
  deps: RunDocumentUploaderDeps,
): (relPath: string, name?: string) => Promise<PublishedDocument> {
  const fetchFn = deps.fetchFn ?? fetch;
  const url = deps.sinkUrl.replace(/\/events$/, "/documents");

  return async (relPath, name) => {
    // The exact path-safety contract of the api_call / api_upload resolvers:
    // full symlink resolution, then root-membership (workspace + /tmp) on the
    // canonical target; dangling symlinks are refused by the lstat gate. A
    // non-existent file surfaces as the lstat ENOENT — no `exists()` probe.
    const { absPath } = await resolveSafeFile(deps.workspace, relPath);
    const documentName = name ?? path.basename(absPath);

    const headers: Record<string, string> = {
      ...sign({
        msgId: randomUUID(),
        timestampSec: Math.floor(Date.now() / 1000),
        body: "",
        secret: deps.sinkSecret,
      }),
      "Content-Type": guessMime(absPath),
      "X-Document-Name": documentName,
    };

    const res = await fetchFn(url, {
      method: "POST",
      headers,
      body: Bun.file(absPath).stream(),
      // Streaming a request body requires the half-duplex opt-in.
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const text = await res.text();
        if (text) detail = `HTTP ${res.status}: ${text}`;
      } catch {
        // ignore — status alone is enough
      }
      throw new Error(`upload of '${relPath}' failed — ${detail}`);
    }

    const doc = (await res.json()) as PublishedDocument;
    deps.publishedShas.add(doc.sha256);
    return doc;
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

  for (const rel of entries) {
    const abs = path.join(outputsDir, rel);
    try {
      // `lstat` (not `stat`) so a symlink is not followed: its target could sit
      // outside the workspace, and the uploader would refuse it anyway. Skip it
      // here with a warning rather than let it reach the uploader as a per-file
      // error.
      const stat = await fs.lstat(abs);
      if (stat.isSymbolicLink()) {
        deps.logWarn?.("outputs sweep skipped symlink", { file: rel });
        continue;
      }
      if (!stat.isFile()) continue;
      if (stat.size > deps.maxFileBytes) {
        deps.logWarn?.("outputs sweep skipped oversized file", {
          file: rel,
          size: stat.size,
          maxFileBytes: deps.maxFileBytes,
        });
        continue;
      }
      const sha = await fileSha256(abs);
      if (deps.publishedShas.has(sha)) continue; // already published by this run

      const doc = await deps.uploader(path.join("outputs", rel), path.basename(rel));
      await deps.emit(documentPublishedEvent(doc));
    } catch (err) {
      // Best-effort: a single file's failure must not abort the sweep or the run.
      deps.logWarn?.("outputs sweep failed to publish a file", {
        file: rel,
        error: getErrorMessage(err),
      });
    }
  }
}
