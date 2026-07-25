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
 * Correlation: direct URL orders match the DownloadItem URL. Authenticated
 * page downloads use a selector that the same command clicks immediately
 * after registering a short-lived pending order. There is no long open
 * FIFO window in which an unrelated user download can be claimed.
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
  /** Direct URL to download. Mutually exclusive with `selector`. */
  url?: string;
  /** Selector clicked atomically after the order is registered. */
  selector?: string;
  /** Platform-minted PUT target (S3 presigned URL or FS upload-sink URL). */
  upload_url: string;
  /** Signed size ceiling — mirrored locally so an oversized file fails fast. */
  max_bytes?: number;
}

export type Notify = (method: string, params: unknown) => void;

interface PendingDownload {
  params: DownloadParams;
  notify: Notify;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  /**
   * The tab that ordered it. With one surface this was implicit; with
   * tabs it is load-bearing — two runs downloading at the same time
   * would otherwise claim each other's file through the FIFO match, and
   * a run would receive a document it was never allowed to see.
   */
  webContents: WebContents;
}

const pending: PendingDownload[] = [];
const PENDING_TIMEOUT_MS = 10_000;

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
export async function startDownload(
  wc: WebContents,
  raw: unknown,
  notify: Notify,
  clickSelector: (selector: string) => Promise<void>,
): Promise<unknown> {
  const p = raw as DownloadParams;
  if (!p || typeof p.download_id !== "string" || !p.upload_url) {
    throw new DownloadError(ERR_INVALID_PARAMS, "download requires download_id and upload_url");
  }
  if (typeof p.selector !== "string") {
    if (typeof p.url !== "string" || !/^https?:\/\//.test(p.url)) {
      throw new DownloadError(ERR_INVALID_PARAMS, "download requires an http(s) url or selector");
    }
  }
  const entry: PendingDownload = {
    params: p,
    notify,
    webContents: wc,
    expiresAt: Date.now() + PENDING_TIMEOUT_MS,
    timer: setTimeout(() => {
      const index = pending.indexOf(entry);
      if (index < 0) return;
      pending.splice(index, 1);
      notify("download.failed", {
        download_id: p.download_id,
        code: ERR_DOWNLOAD_FAILED,
        message: "download did not start within 10 seconds",
      });
    }, PENDING_TIMEOUT_MS),
  };
  pending.push(entry);
  try {
    if (p.selector !== undefined) {
      await clickSelector(p.selector);
    } else {
      wc.downloadURL(p.url!);
    }
  } catch (err) {
    clearTimeout(entry.timer);
    const index = pending.indexOf(entry);
    if (index >= 0) pending.splice(index, 1);
    throw err;
  }
  return { download_id: p.download_id, state: "started" };
}

/**
 * Install the `will-download` listener for a session. Agent-ordered
 * downloads (pending FIFO, matched within the ORDERING TAB) go to a temp
 * file and get uploaded to the platform; anything else keeps the
 * user-facing default (Documents dir).
 *
 * Idempotent per session: with one partition per agent profile there are
 * now several sessions, and a tab reusing an already-equipped session
 * must not stack a second listener (which would double-handle every
 * download).
 */
const equippedSessions = new WeakSet<Session>();

export function installDownloadInterceptor(session: Session, debugLog: (m: string) => void): void {
  if (equippedSessions.has(session)) return;
  equippedSessions.add(session);
  session.on("will-download", (_event, item, webContents) => {
    const now = Date.now();
    for (let i = pending.length - 1; i >= 0; i--) {
      if (pending[i]!.expiresAt <= now) {
        clearTimeout(pending[i]!.timer);
        pending.splice(i, 1);
      }
    }
    const itemUrl = item.getURL();
    const itemUrlChain = item.getURLChain();
    // Match within the ordering tab only. A selector order is bound to
    // the tab whose control was clicked; a URL order to the tab that
    // asked for that URL.
    const matchingIndex = pending.findIndex(
      (entry) =>
        entry.webContents === webContents &&
        (entry.params.selector !== undefined ||
          entry.params.url === itemUrl ||
          (entry.params.url !== undefined && itemUrlChain.includes(entry.params.url))),
    );
    const agentOrder = matchingIndex >= 0 ? pending.splice(matchingIndex, 1)[0] : undefined;
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
    clearTimeout(agentOrder.timer);
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
