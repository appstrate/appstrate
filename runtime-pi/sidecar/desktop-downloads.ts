// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Sidecar-local half of the `desktop_download` data plane.
 *
 * The agent-side extension cannot reach the platform (no run token in
 * the agent container) and the sidecar cannot reach the workspace (no
 * mount). So the bytes make a relay handoff here:
 *
 *   platform storage ──(download_pull: one streamed GET)──► sidecar /tmp
 *   sidecar /tmp ──(download_read: bounded base64 slices)──► extension
 *   extension ──(fs write)──► /workspace/downloads/<file>
 *
 * Each hop is streamed or bounded — the full file is never held in
 * memory, and MCP envelopes stay under the transport cap.
 */

import { createHash } from "node:crypto";
import { mkdir, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Bounded read slice — keeps base64 well under the MCP envelope cap. */
export const DOWNLOAD_READ_MAX_BYTES = 1024 * 1024;

const TMP_DIR = join(tmpdir(), "appstrate-sidecar-dl");
const ID_PATTERN = /^dl_[\w-]+$/;

interface PulledDownload {
  path: string;
  size: number;
  sha256: string;
}

const pulled = new Map<string, PulledDownload>();

type ToolText = {
  [x: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function ok(result: unknown): ToolText {
  return { content: [{ type: "text", text: JSON.stringify({ result }) }] };
}

function fail(message: string): ToolText {
  return { content: [{ type: "text", text: message }], isError: true };
}

export async function handleLocalDownloadMethod(
  method: string,
  rawParams: unknown,
  config: { platformApiUrl: string; runToken: string },
  fetchFn: typeof fetch,
): Promise<ToolText> {
  const params = (rawParams ?? {}) as {
    download_id?: string;
    offset?: number;
    length?: number;
  };
  const id = params.download_id;
  if (!id || !ID_PATTERN.test(id)) {
    return fail("download_pull/read/done require a valid `download_id`");
  }

  if (method === "browser.download_pull") {
    const existing = pulled.get(id);
    if (existing) return ok({ size: existing.size, sha256: existing.sha256 });
    let res: Response;
    try {
      res = await fetchFn(`${config.platformApiUrl}/internal/desktop-download/${id}`, {
        headers: { Authorization: `Bearer ${config.runToken}` },
      });
    } catch (err) {
      return fail(`download_pull: platform fetch failed: ${(err as Error).message ?? err}`);
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      return fail(
        `download_pull: platform replied ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
      );
    }
    await mkdir(TMP_DIR, { recursive: true });
    const path = join(TMP_DIR, id);
    const hash = createHash("sha256");
    // Plain reader loop over fs/promises — deliberately avoids the
    // node:stream/promises pipeline + TransformStream + Readable.fromWeb
    // combination: adding those builtins to the standalone sidecar
    // binary coincided with a Bun segfault at startup (musl/arm64,
    // Bun 1.3.14). Chunks flow reader → hash → file, never buffered
    // whole.
    const reader = res.body.getReader();
    const out = await open(path, "w");
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        await out.write(value);
      }
    } finally {
      await out.close();
    }
    const { size } = await stat(path);
    const entry = { path, size, sha256: hash.digest("hex") };
    pulled.set(id, entry);
    return ok({ size: entry.size, sha256: entry.sha256 });
  }

  if (method === "browser.download_read") {
    const entry = pulled.get(id);
    if (!entry) return fail("download_read: call download_pull first");
    const offset = Math.max(0, Math.floor(params.offset ?? 0));
    const length = Math.min(
      Math.max(1, Math.floor(params.length ?? DOWNLOAD_READ_MAX_BYTES)),
      DOWNLOAD_READ_MAX_BYTES,
    );
    const handle = await open(entry.path, "r");
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return ok({
        offset,
        length: bytesRead,
        eof: offset + bytesRead >= entry.size,
        data: buffer.subarray(0, bytesRead).toString("base64"),
      });
    } finally {
      await handle.close();
    }
  }

  if (method === "browser.download_done") {
    const entry = pulled.get(id);
    pulled.delete(id);
    if (entry) await rm(entry.path, { force: true });
    return ok({ ok: true });
  }

  return fail(`unknown local download method: ${method}`);
}
