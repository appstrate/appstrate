// SPDX-License-Identifier: Apache-2.0

/**
 * Agent-triggered downloads — the desktop half of `browser.download`.
 *
 * Control plane vs data plane: the WebSocket only ever carries small
 * JSON-RPC messages (the download order, progress/completed/failed
 * notifications). The bytes themselves never touch the WS — the file is
 * downloaded to a temp path by Chromium (with the page's own session,
 * so authenticated URLs work), then STREAMED over HTTPS to the
 * platform-minted upload URL (S3 presigned PUT, or the FS upload sink).
 *
 * Correlation: `session.will-download` fires for every download in the
 * pane, agent-triggered or user-clicked. Agent downloads are correlated
 * FIFO — `browser.download` pushes a pending entry, the next
 * `will-download` claims it. User-initiated downloads (no pending entry)
 * keep the historical behavior: saved under ~/Documents/AppstrateDesktop.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { Session, WebContents } from "electron";
import { app } from "electron";
import { ERR_DOWNLOAD_FAILED, ERR_INVALID_PARAMS } from "./protocol.ts";

export interface DownloadParams {
  download_id: string;
  url: string;
  /** Platform-minted PUT target (S3 presigned URL or FS upload-sink URL). */
  upload_url: string;
  /** Signed size ceiling — mirrored locally so an oversized file fails fast. */
  max_bytes?: number;
}

export type Notify = (method: string, params: unknown) => void;

interface PendingDownload {
  params: DownloadParams;
  notify: Notify;
}

/** FIFO of agent-ordered downloads awaiting their `will-download` event. */
const pending: PendingDownload[] = [];

class DownloadError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "DownloadError";
  }
}

/**
 * Handler for `browser.download`. Registers the pending entry and
 * triggers the download through the page's session (cookies included),
 * then returns immediately — completion is reported via notifications.
 */
export function startDownload(wc: WebContents, raw: unknown, notify: Notify): unknown {
  const p = raw as DownloadParams;
  if (!p || typeof p.download_id !== "string" || typeof p.url !== "string" || !p.upload_url) {
    throw new DownloadError(ERR_INVALID_PARAMS, "download requires download_id, url, upload_url");
  }
  if (!/^https?:\/\//.test(p.url)) {
    throw new DownloadError(ERR_INVALID_PARAMS, `not an http(s) URL: ${p.url}`);
  }
  pending.push({ params: p, notify });
  wc.downloadURL(p.url);
  return { download_id: p.download_id, state: "started" };
}

/**
 * Install the single `will-download` listener for the browser pane's
 * session. Replaces the previous main.ts inline handler: agent-ordered
 * downloads (pending FIFO) go to a temp file and get uploaded to the
 * platform; anything else keeps the user-facing default (Documents dir).
 */
export function installDownloadInterceptor(session: Session, debugLog: (m: string) => void): void {
  session.on("will-download", (_event, item) => {
    const agentOrder = pending.shift();
    if (!agentOrder) {
      // User-initiated download — historical behavior.
      let host = "unknown";
      try {
        host = new URL(item.getURL()).host;
      } catch {
        // best-effort
      }
      const baseDir = join(app.getPath("documents"), "AppstrateDesktop", host);
      const safeName = item.getFilename().replace(/[/\\?%*:|"<>]/g, "_");
      item.setSavePath(join(baseDir, safeName));
      debugLog(`[download] ${item.getURL()} → ${baseDir}/${safeName}\n`);
      return;
    }

    const { params, notify } = agentOrder;
    const id = params.download_id;
    const tmpPath = join(tmpdir(), "appstrate-desktop", `${id}.part`);
    void mkdir(join(tmpdir(), "appstrate-desktop"), { recursive: true });
    item.setSavePath(tmpPath);
    debugLog(`[download:agent] ${id} ${item.getURL()} → ${tmpPath}\n`);

    let lastQuarter = 0;
    item.on("updated", (_e, state) => {
      if (state !== "progressing") return;
      const total = item.getTotalBytes();
      const max = params.max_bytes ?? 0;
      if (max > 0 && (item.getReceivedBytes() > max || total > max)) {
        debugLog(`[download:agent] ${id} exceeds max_bytes ${max} — cancelling\n`);
        item.cancel();
        return;
      }
      if (total > 0) {
        const quarter = Math.floor((item.getReceivedBytes() / total) * 4);
        if (quarter > lastQuarter) {
          lastQuarter = quarter;
          notify("download.progress", { download_id: id, pct: quarter * 25 });
        }
      }
    });

    item.once("done", (_e, state) => {
      void (async () => {
        try {
          if (state !== "completed") {
            throw new DownloadError(ERR_DOWNLOAD_FAILED, `download ${state}`);
          }
          const { size, sha256 } = await hashFile(tmpPath);
          if (params.max_bytes && size > params.max_bytes) {
            throw new DownloadError(
              ERR_DOWNLOAD_FAILED,
              `file is ${size} bytes, over the ${params.max_bytes} limit`,
            );
          }
          await uploadFileStream(tmpPath, size, params.upload_url);
          notify("download.completed", { download_id: id, size, sha256 });
          debugLog(`[download:agent] ${id} uploaded (${size} bytes, sha256 ${sha256})\n`);
        } catch (err) {
          const code = err instanceof DownloadError ? err.code : ERR_DOWNLOAD_FAILED;
          const message = err instanceof Error ? err.message : String(err);
          notify("download.failed", { download_id: id, code, message });
          debugLog(`[download:agent] ${id} FAILED: ${message}\n`);
        } finally {
          await rm(tmpPath, { force: true });
        }
      })();
    });
  });
}

async function hashFile(path: string): Promise<{ size: number; sha256: string }> {
  const { size } = await stat(path);
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve())
      .on("error", reject);
  });
  return { size, sha256: hash.digest("hex") };
}

/**
 * PUT the file to the platform-minted URL, streamed (never buffered
 * whole). Works against both sink shapes: the FS upload sink and an S3
 * presigned PUT — both accept a raw-body PUT.
 */
async function uploadFileStream(path: string, size: number, uploadUrl: string): Promise<void> {
  const body = Readable.toWeb(createReadStream(path)) as ReadableStream;
  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(size),
    },
    body,
    // Node/Electron requirement for streamed request bodies.
    duplex: "half",
  } as RequestInit);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new DownloadError(
      ERR_DOWNLOAD_FAILED,
      `upload sink replied ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
    );
  }
}
