// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Agent-side Pi extension for the `desktop_download` tool.
 *
 * Why an extension and NOT a sidecar handler (same rationale as
 * `api-upload-extension.ts`, mirrored): the destination is the run
 * WORKSPACE, which the credential-isolated sidecar deliberately cannot
 * see — and the agent container holds no run token, so it cannot fetch
 * from the platform directly either. The bytes therefore relay:
 * platform → sidecar temp (one streamed pull), sidecar → here in
 * bounded base64 slices, here → workspace file. Nothing ever enters the
 * LLM context except the final `{path, size, sha256}`.
 *
 * Routed by `direct.ts` from the `dev.appstrate/desktop-download`
 * `_meta` marker on the sidecar-advertised descriptor.
 */

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { Type, type ExtensionAPI, type ExtensionFactory } from "../pi-sdk.ts";
import type { AppstrateMcpClient } from "@appstrate/mcp-transport";

const POLL_INTERVAL_MS = 2_500;
const DEFAULT_TIMEOUT_MS = 300_000;
const READ_CHUNK_BYTES = 1024 * 1024;

export interface BuildDesktopDownloadFactoryOptions {
  /** The advertised `desktop_download` tool from the sidecar's `tools/list`. */
  tool: { name: string; description?: string; inputSchema?: unknown };
  mcp: AppstrateMcpClient;
  runId: string;
  /** Workspace root the downloaded file is written under (`downloads/`). */
  workspace: string;
}

/**
 * Call a `desktop_browser` method through the sidecar and parse the
 * `{"result": …}` envelope every leg of this pipeline speaks (both the
 * platform passthrough and the sidecar-local download methods).
 */
async function callBridge(
  mcp: AppstrateMcpClient,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const res = await mcp.callTool(
    { name: "desktop_browser", arguments: args },
    { signal, timeoutMs: 120_000 },
  );
  const text = (res.content as Array<{ type?: string; text?: string }> | undefined)
    ?.filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
  if (res.isError) throw new Error(text || "desktop_browser failed");
  try {
    const parsed = JSON.parse(text ?? "") as { result?: unknown };
    return parsed.result;
  } catch {
    throw new Error(`desktop_browser: unparseable reply: ${(text ?? "").slice(0, 200)}`);
  }
}

export function buildDesktopDownloadToolFactory(
  opts: BuildDesktopDownloadFactoryOptions,
): ExtensionFactory[] {
  return [
    (pi: ExtensionAPI) => {
      pi.registerTool({
        name: opts.tool.name,
        label: opts.tool.name,
        description:
          opts.tool.description ??
          "Materialize a completed browser.download into the run workspace; returns {path, size, sha256}.",
        parameters: Type.Unsafe<Record<string, unknown>>(
          (opts.tool.inputSchema as Record<string, unknown>) ?? {
            type: "object",
            additionalProperties: false,
            required: ["download_id"],
            properties: {
              download_id: { type: "string" },
              timeout_ms: { type: "integer", minimum: 1000, maximum: 600000 },
            },
          },
        ),
        async execute(_toolCallId, params, signal) {
          const args = (params ?? {}) as { download_id?: string; timeout_ms?: number };
          const abort = signal ?? new AbortController().signal;
          const fail = (text: string) => ({
            content: [{ type: "text" as const, text: `desktop_download: ${text}` }],
            details: undefined,
            isError: true,
          });
          if (!args.download_id) return fail("missing download_id");
          const downloadId = args.download_id;
          const deadline = Date.now() + Math.min(args.timeout_ms ?? DEFAULT_TIMEOUT_MS, 600_000);

          try {
            // 1. Wait for the desktop to finish downloading + uploading.
            let filename = "download.bin";
            for (;;) {
              const status = (await callBridge(
                opts.mcp,
                { method: "browser.download_status", params: { download_id: downloadId } },
                abort,
              )) as {
                state?: string;
                pct?: number;
                filename?: string;
                error?: { message?: string };
              };
              if (typeof status?.filename === "string") filename = status.filename;
              if (status?.state === "uploaded") break;
              if (status?.state === "failed") {
                return fail(
                  `download failed on the desktop: ${status.error?.message ?? "unknown"}`,
                );
              }
              if (Date.now() > deadline) {
                return fail(`timed out waiting for the download (last state: ${status?.state})`);
              }
              await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
            }

            // 2. One streamed platform → sidecar pull.
            const pulledRaw = (await callBridge(
              opts.mcp,
              { method: "browser.download_pull", params: { download_id: downloadId } },
              abort,
            )) as { size?: number; sha256?: string };
            const size = pulledRaw?.size ?? 0;

            // 3. Bounded slices sidecar → workspace file. The path is
            // pinned under workspace/downloads — the filename came from
            // the platform record (already sanitized), and the resolve
            // check refuses anything that would escape anyway.
            const downloadsDir = join(opts.workspace, "downloads");
            await mkdir(downloadsDir, { recursive: true });
            const target = resolve(downloadsDir, filename);
            if (!target.startsWith(resolve(downloadsDir) + sep)) {
              return fail(`refusing suspicious filename: ${filename}`);
            }
            const hash = createHash("sha256");
            const out = createWriteStream(target);
            let offset = 0;
            try {
              for (;;) {
                const slice = (await callBridge(
                  opts.mcp,
                  {
                    method: "browser.download_read",
                    params: { download_id: downloadId, offset, length: READ_CHUNK_BYTES },
                  },
                  abort,
                )) as { data?: string; length?: number; eof?: boolean };
                const bytes = Buffer.from(slice?.data ?? "", "base64");
                if (bytes.length > 0) {
                  hash.update(bytes);
                  await new Promise<void>((res, rej) =>
                    out.write(bytes, (err) => (err ? rej(err) : res())),
                  );
                  offset += bytes.length;
                }
                if (slice?.eof || bytes.length === 0) break;
              }
            } finally {
              await new Promise<void>((res) => out.end(() => res()));
            }

            // 4. Release the sidecar temp file and verify integrity.
            await callBridge(
              opts.mcp,
              { method: "browser.download_done", params: { download_id: downloadId } },
              abort,
            ).catch(() => {});
            const sha256 = hash.digest("hex");
            if (pulledRaw?.sha256 && pulledRaw.sha256 !== sha256) {
              return fail(
                `integrity check failed: workspace sha256 ${sha256} != pulled ${pulledRaw.sha256}`,
              );
            }
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    path: `downloads/${filename}`,
                    size: size || offset,
                    sha256,
                  }),
                },
              ],
              details: undefined,
              isError: false,
            };
          } catch (err) {
            return fail(err instanceof Error ? err.message : String(err));
          }
        },
      });
    },
  ];
}
