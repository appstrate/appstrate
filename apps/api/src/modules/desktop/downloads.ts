// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Agent-triggered downloads — platform-side state machine.
 *
 * `browser.download` mints a storage upload URL (S3 presigned PUT or the
 * FS upload sink, whichever backend the instance runs), dispatches the
 * order to the run owner's desktop, and tracks the download's lifecycle
 * from the desktop's JSON-RPC notifications:
 *
 *   started ──► downloading(pct) ──► uploaded ──► (fetched by the run)
 *                     │
 *                     └────────────► failed(code, message)
 *
 * The bytes flow desktop → storage over HTTPS (data plane) — never over
 * the WebSocket (control plane). The run's sidecar then streams them
 * from `/internal/desktop-download/{id}` into its local disk, and the
 * agent-side extension chunks them into the workspace.
 *
 * Process-local, like the client registry and the scrub store — one
 * instance dispatches, the same instance receives the notifications.
 * Records age out after {@link RETENTION_MS}; the sweep also deletes the
 * storage object so an abandoned download doesn't leak bytes.
 */

import { randomUUID } from "node:crypto";
import { createUploadUrl, deleteFile as storageDelete } from "@appstrate/db/storage";
import { logger } from "../../lib/logger.ts";
import { sanitizeFilename } from "../../services/uploads.ts";

const BUCKET = "desktop-downloads";
const RETENTION_MS = 60 * 60 * 1000;
const UPLOAD_EXPIRY_SECONDS = 15 * 60;
/** Default per-download size ceiling — matches the upload sink's design cap. */
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;

export type DownloadState = "started" | "downloading" | "uploaded" | "failed";

export interface DownloadRecord {
  downloadId: string;
  runId: string;
  userId: string;
  filename: string;
  storageKey: string;
  state: DownloadState;
  pct: number;
  size: number | null;
  sha256: string | null;
  error: { code: number; message: string } | null;
  createdAt: number;
}

const records = new Map<string, DownloadRecord>();

function sweep(now: number): void {
  for (const [id, rec] of records) {
    if (now - rec.createdAt > RETENTION_MS) {
      records.delete(id);
      void storageDelete(BUCKET, rec.storageKey).catch(() => {});
    }
  }
}

/**
 * Create a download record and mint its upload target. Returns what the
 * desktop needs (URL + ceiling) and what the agent gets back (id).
 */
export async function createDownload(opts: {
  runId: string;
  userId: string;
  filename?: string;
  maxBytes?: number;
}): Promise<{ record: DownloadRecord; uploadUrl: string; maxBytes: number }> {
  const now = Date.now();
  sweep(now);
  const downloadId = `dl_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const filename = sanitizeFilename(opts.filename ?? "download.bin");
  const storageKey = `${opts.runId}/${downloadId}/${filename}`;
  const maxBytes = Math.min(opts.maxBytes ?? DEFAULT_MAX_BYTES, DEFAULT_MAX_BYTES);
  // No `maxSize`: on direct-presign S3 it would sign an EXACT
  // Content-Length, and the size is only known once the desktop has
  // downloaded the file. The ceiling is enforced desktop-side (the
  // client cancels an over-limit download before uploading); the token
  // is single-use and 15-minute-bound, which caps the abuse surface of
  // a hostile client at one unbounded object per order.
  const { url } = await createUploadUrl(BUCKET, storageKey, {
    expiresIn: UPLOAD_EXPIRY_SECONDS,
  });
  const record: DownloadRecord = {
    downloadId,
    runId: opts.runId,
    userId: opts.userId,
    filename,
    storageKey,
    state: "started",
    pct: 0,
    size: null,
    sha256: null,
    error: null,
    createdAt: now,
  };
  records.set(downloadId, record);
  return { record, uploadUrl: url, maxBytes };
}

/**
 * Look up a record, scoped to the requesting run — a leaked run token
 * must not be able to probe (or fetch) another run's downloads.
 */
export function getDownloadForRun(runId: string, downloadId: string): DownloadRecord | null {
  const rec = records.get(downloadId);
  if (!rec || rec.runId !== runId) return null;
  return rec;
}

/**
 * Desktop-notification intake, registered on the client registry at
 * module init. Frames are attributed to the WS's authenticated user;
 * a notification for a download that user does not own is dropped —
 * the desktop can only ever affect its own orders.
 */
export function handleDesktopNotification(userId: string, method: string, params: unknown): void {
  const p = params as {
    download_id?: string;
    pct?: number;
    size?: number;
    sha256?: string;
    code?: number;
    message?: string;
  };
  if (!p || typeof p.download_id !== "string") return;
  const rec = records.get(p.download_id);
  if (!rec || rec.userId !== userId) {
    logger.debug("Desktop downloads: notification for unknown/foreign download", {
      module: "desktop",
      method,
      downloadId: p.download_id,
    });
    return;
  }
  switch (method) {
    case "download.progress":
      if (rec.state === "started" || rec.state === "downloading") {
        rec.state = "downloading";
        rec.pct = typeof p.pct === "number" ? Math.max(0, Math.min(100, p.pct)) : rec.pct;
      }
      return;
    case "download.completed":
      rec.state = "uploaded";
      rec.pct = 100;
      rec.size = typeof p.size === "number" ? p.size : null;
      rec.sha256 = typeof p.sha256 === "string" ? p.sha256 : null;
      logger.info("Desktop download uploaded", {
        module: "desktop",
        runId: rec.runId,
        downloadId: rec.downloadId,
        size: rec.size,
      });
      return;
    case "download.failed":
      rec.state = "failed";
      rec.error = {
        code: typeof p.code === "number" ? p.code : -32000,
        message: typeof p.message === "string" ? p.message : "download failed",
      };
      logger.warn("Desktop download failed", {
        module: "desktop",
        runId: rec.runId,
        downloadId: rec.downloadId,
        code: rec.error.code,
      });
      return;
    default:
      logger.debug("Desktop downloads: unknown notification method", {
        module: "desktop",
        method,
      });
  }
}

/** Public wire shape of a record (agent/status surface). */
export function toStatusPayload(rec: DownloadRecord): Record<string, unknown> {
  return {
    download_id: rec.downloadId,
    state: rec.state,
    pct: rec.pct,
    filename: rec.filename,
    ...(rec.size !== null ? { size: rec.size } : {}),
    ...(rec.sha256 !== null ? { sha256: rec.sha256 } : {}),
    ...(rec.error ? { error: rec.error } : {}),
  };
}

/** Test-only: reset the store between cases. */
export function clearDownloads(): void {
  records.clear();
}

export { BUCKET as DOWNLOADS_BUCKET };
