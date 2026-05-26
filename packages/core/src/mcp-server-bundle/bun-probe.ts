// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Bun compatibility probe (D31, proposal §5.3 Phase 1.05).
 *
 * After vendoring an `npx` integration, the bundler optionally spawns
 * the resulting `./server/<entryPoint>` under Bun and performs a
 * minimal MCP stdio handshake (`initialize` → `tools/list`). The probe
 * tells the publish pipeline whether the server actually runs under
 * Bun — which is the platform's chosen Node-compatible runtime (D31).
 * Operates on the AFPS-native mcp-server manifest (MCPB-vocabulary
 * `server` / `tools` / `user_config` fields lifted to the root alongside
 * AFPS identity — see AFPS §3.4).
 * When the probe fails, the bundle is marked `_meta.bunCompat: false`
 * and the caller can fall back to `server.type: "docker"` against a
 * Node-on-Docker image.
 *
 * The probe is best-effort and time-boxed (default 10s). It never
 * throws on probe failure — the result object encodes the outcome.
 * Spawn failures (Bun missing, file missing) DO surface as failures
 * (with `reason`) so CI can tell the difference between "ran and
 * failed" and "couldn't run at all".
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import type { BunCompatProbeResult } from "./types.ts";

export interface BunProbeOptions {
  /** Hard wall-clock budget. Default 10000 ms. */
  timeoutMs?: number;
  /** Path to a `bun` binary. Defaults to `bun` on PATH. */
  bunPath?: string;
  /** Override the entry point to spawn (relative to bundle root). */
  entryPoint?: string;
  /** Working directory root for the materialised tree. */
  workRoot?: string;
}

/**
 * Materialise the bundle's `./server/` tree into a temp directory and
 * run the probe against it. Accepting the file map directly avoids
 * round-tripping through a real ZIP just to run the probe.
 */
export async function probeBunCompat(
  files: Record<string, Uint8Array>,
  entryPoint: string,
  options: BunProbeOptions = {},
): Promise<BunCompatProbeResult> {
  const startedAt = performance.now();
  const timeoutMs = options.timeoutMs ?? 10_000;
  const bunPath = options.bunPath ?? "bun";
  const workRoot = options.workRoot ?? tmpdir();

  const workDir = await mkdtemp(join(workRoot, "afps-bundle-probe-"));
  try {
    // Materialise the relevant subset on disk (Bun.write creates parent dirs).
    for (const [rel, bytes] of Object.entries(files)) {
      await Bun.write(join(workDir, rel), bytes);
    }
    const cleanEntry = entryPoint.replace(/^\.\//, "");
    const entryAbs = join(workDir, cleanEntry);

    return await runProbe(bunPath, entryAbs, timeoutMs, startedAt);
  } catch (err) {
    return {
      ok: false,
      reason: `probe setup failed: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Math.round(performance.now() - startedAt),
    };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function runProbe(
  bunPath: string,
  entryAbs: string,
  timeoutMs: number,
  startedAt: number,
): Promise<BunCompatProbeResult> {
  return new Promise<BunCompatProbeResult>((resolve) => {
    let settled = false;
    const settle = (r: BunCompatProbeResult) => {
      if (settled) return;
      settled = true;
      try {
        if (proc.exitCode === null && !proc.killed) proc.kill("SIGKILL");
      } catch {
        // ignore
      }
      resolve({ ...r, durationMs: Math.round(performance.now() - startedAt) });
    };

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(bunPath, [entryAbs], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });
    } catch (err) {
      settle({
        ok: false,
        reason: `failed to spawn bun: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    const stderrChunks: Buffer[] = [];
    proc.stderr?.on("data", (c: Buffer) => stderrChunks.push(c));
    proc.on("error", (err) => {
      settle({ ok: false, reason: `spawn error: ${err.message}` });
    });
    proc.on("exit", (code) => {
      if (settled) return;
      const stderr = Buffer.concat(stderrChunks).toString("utf8").slice(0, 500);
      settle({
        ok: false,
        reason: `server exited (code ${code}) before completing MCP handshake. stderr: ${stderr}`,
      });
    });

    const timer = setTimeout(() => {
      settle({ ok: false, reason: `probe timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    timer.unref();

    // MCP stdio JSON-RPC framing: one JSON object per line on
    // stdout. We pipeline `initialize` then `tools/list` and resolve
    // on the second response.
    const buffer: Buffer[] = [];
    let toolCount: number | undefined;
    proc.stdout?.on("data", (chunk: Buffer) => {
      buffer.push(chunk);
      const all = Buffer.concat(buffer).toString("utf8");
      const lines = all.split(/\r?\n/);
      // Keep the trailing partial line in the buffer.
      const trailing = lines.pop();
      buffer.length = 0;
      if (trailing && trailing.length > 0) buffer.push(Buffer.from(trailing, "utf8"));
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let msg: { id?: number | string; result?: { tools?: unknown[] } };
        try {
          msg = JSON.parse(trimmed) as typeof msg;
        } catch {
          continue;
        }
        if (msg.id === 1 && msg.result) {
          // initialize succeeded — fire tools/list.
          const listReq = {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/list",
            params: {},
          };
          proc.stdin?.write(JSON.stringify(listReq) + "\n");
        }
        if (msg.id === 2 && msg.result) {
          toolCount = Array.isArray(msg.result.tools) ? msg.result.tools.length : 0;
          clearTimeout(timer);
          settle({ ok: true, toolCount });
        }
      }
    });

    // Send the initialize request.
    const initReq = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "afps-bundle-probe", version: "0.0.0" },
      },
    };
    proc.stdin?.write(JSON.stringify(initReq) + "\n");
  });
}
