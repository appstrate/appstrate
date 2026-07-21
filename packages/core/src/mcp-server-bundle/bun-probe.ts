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

import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import type { BunCompatProbeResult } from "./types.ts";

/**
 * Environment variables forwarded to the spawned (third-party) MCP server
 * during the probe. Deliberately a minimal system allowlist: the probe
 * runs untrusted vendored code, so forwarding the full `process.env` would
 * leak platform secrets (credential-encryption keys, DATABASE_URL,
 * provider tokens, session secrets) into it during the handshake. Only the
 * variables a well-behaved runtime needs to locate binaries and its own
 * cache/temp are passed through.
 */
const PROBE_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TZ",
  // Windows essentials — bun/node resolve these to find the shell + profile.
  "SystemRoot",
  "SYSTEMROOT",
  "PATHEXT",
  "COMSPEC",
  "WINDIR",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
] as const;

/** Copy only the allowlisted, non-secret system vars from `process.env`. */
function buildProbeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PROBE_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

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

export interface StdioProbeOptions {
  /** Hard wall-clock budget. Default 10000 ms. */
  timeoutMs?: number;
  /** Interpreter or executable used to start the bundled entry point. */
  executable: string;
  /** Arguments inserted before the absolute entry-point path. */
  executableArgs?: readonly string[];
  /** Explicit, non-secret additions to the minimal probe environment. */
  env?: Readonly<Record<string, string>>;
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
  return probeStdioCompat(files, entryPoint, {
    executable: options.bunPath ?? "bun",
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.workRoot !== undefined ? { workRoot: options.workRoot } : {}),
  });
}

/**
 * Runtime-neutral MCP stdio probe used by conformance checks for first-party
 * runtimes that are not Bun. The caller must provide the executable and may
 * add only the explicit, non-secret environment required by that runtime.
 */
export async function probeStdioCompat(
  files: Record<string, Uint8Array>,
  entryPoint: string,
  options: StdioProbeOptions,
): Promise<BunCompatProbeResult> {
  const startedAt = performance.now();
  const timeoutMs = options.timeoutMs ?? 10_000;
  const workRoot = options.workRoot ?? tmpdir();

  const workDir = await mkdtemp(join(workRoot, "afps-bundle-probe-"));
  try {
    // Materialise the relevant subset on disk (Bun.write creates parent dirs).
    for (const [rel, bytes] of Object.entries(files)) {
      await Bun.write(join(workDir, rel), bytes);
    }
    const cleanEntry = entryPoint.replace(/^\.\//, "");
    const entryAbs = join(workDir, cleanEntry);

    return await runProbe(
      [options.executable, ...(options.executableArgs ?? []), entryAbs],
      timeoutMs,
      startedAt,
      options.env,
    );
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
  command: string[],
  timeoutMs: number,
  startedAt: number,
  explicitEnv?: Readonly<Record<string, string>>,
): Promise<BunCompatProbeResult> {
  const withDuration = (r: BunCompatProbeResult): BunCompatProbeResult => ({
    ...r,
    durationMs: Math.round(performance.now() - startedAt),
  });

  let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    proc = Bun.spawn(command, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      // SECURITY: never forward the full process.env to third-party MCP
      // code — pass only a minimal, non-secret system allowlist.
      env: { ...buildProbeEnv(), ...explicitEnv },
    });
  } catch (err) {
    return withDuration({
      ok: false,
      reason: `failed to spawn ${command[0]}: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  const writeLine = (obj: unknown): void => {
    try {
      proc.stdin.write(JSON.stringify(obj) + "\n");
      proc.stdin.flush();
    } catch {
      // Broken pipe — the stdout-scan/exit path surfaces the failure.
    }
  };

  const killProc = (): void => {
    try {
      if (proc.exitCode === null && !proc.killed) proc.kill();
    } catch {
      // ignore
    }
  };

  // Drain stderr concurrently for diagnostics on the failure path.
  const stderrText = new Response(proc.stderr).text().catch(() => "");

  // MCP stdio JSON-RPC framing: one JSON object per line on stdout. Scan
  // line-by-line — on the `initialize` reply fire `tools/list`, resolve on
  // the `tools/list` reply. Written so it never rejects: any stream error
  // (e.g. the process being killed on timeout) falls through to the
  // exit-based failure summary.
  const scan = async (): Promise<BunCompatProbeResult> => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: false });
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        // Keep the trailing partial line in the buffer.
        buffer = lines.pop() ?? "";
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
            writeLine({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
          }
          if (msg.id === 2 && msg.result) {
            const tools = Array.isArray(msg.result.tools) ? msg.result.tools : [];
            const toolNames = tools
              .map((t) => (t as { name?: unknown }).name)
              .filter((n): n is string => typeof n === "string");
            return { ok: true, toolCount: tools.length, toolNames };
          }
        }
      }
    } catch {
      // Stream errored (process killed mid-read) — fall through below.
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore — reader may already be released
      }
    }
    const code = await proc.exited;
    const stderr = (await stderrText).slice(0, 500);
    return {
      ok: false,
      reason: `server exited (code ${code}) before completing MCP handshake. stderr: ${stderr}`,
    };
  };

  const timeout = new Promise<BunCompatProbeResult>((resolve) => {
    const timer = setTimeout(
      () => resolve({ ok: false, reason: `probe timed out after ${timeoutMs}ms` }),
      timeoutMs,
    );
    timer.unref?.();
  });

  // Send the initialize request, then race the handshake scan against the
  // hard wall-clock timeout.
  writeLine({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "afps-bundle-probe", version: "0.0.0" },
    },
  });

  try {
    return withDuration(await Promise.race([scan(), timeout]));
  } finally {
    killProc();
  }
}
