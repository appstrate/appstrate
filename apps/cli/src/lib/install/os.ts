// SPDX-License-Identifier: Apache-2.0

/**
 * OS-interaction primitives shared by the tier install flows —
 * subprocess spawning, PATH lookup, HTTP healthcheck polling.
 *
 * Kept in one module so tests can stub them via DI (see each export's
 * `factory` companion). The functions are intentionally thin: they
 * wrap Bun / Node built-ins without adding retry, logging, or
 * transformation beyond what every caller needs.
 */

import { spawn, spawnSync, type SpawnOptions } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export interface CommandResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * `"inherit"` streams to the CLI's stdio (what the user sees during
   * docker compose up). `"ignore"` throws output away (probes). `"pipe"`
   * captures into the returned `stdout` / `stderr`.
   */
  stdio?: "inherit" | "ignore" | "pipe";
}

/** Run `cmd args...` and await its exit. Never throws on non-zero — returns `ok: false` instead. */
export async function runCommand(
  cmd: string,
  args: string[],
  opts: RunCommandOptions = {},
): Promise<CommandResult> {
  const stdio = opts.stdio ?? "pipe";
  return new Promise((resolve) => {
    // `cmd` and `args` are passed separately (no shell invocation), so
    // special characters in args cannot trigger command injection — the
    // child runs directly via `execve`. We also do NOT wire `process.env`
    // into the `env` option: leaving it undefined makes Node inherit the
    // parent environment by default, with the side benefit of cutting
    // the dataflow that CodeQL's `js/shell-command-injection-from-
    // environment` rule traces from `process.env` into `spawn()`. The
    // effective behavior is unchanged — children still see the same env
    // they would have via the previous `env: opts.env ?? process.env`.
    const spawnOpts: SpawnOptions = {
      cwd: opts.cwd,
      stdio: stdio === "pipe" ? ["ignore", "pipe", "pipe"] : stdio,
    };
    if (opts.env) spawnOpts.env = opts.env;
    const child = spawn(cmd, args, spawnOpts);

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", () => {
      // ENOENT when `cmd` is not on PATH — surface as ok:false.
      resolve({ ok: false, exitCode: -1, stdout, stderr });
    });
    child.on("close", (code) => {
      const exitCode = code ?? -1;
      resolve({ ok: exitCode === 0, exitCode, stdout, stderr });
    });
  });
}

/** Synchronous `which` — returns `true` if `cmd` is on PATH. */
export function commandExists(cmd: string): boolean {
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], {
    stdio: "ignore",
  });
  return probe.status === 0;
}

/**
 * Poll `url` with a HEAD (fall back to GET on 405) until a 2xx/3xx
 * response or the deadline elapses. Returns `true` on success,
 * `false` on timeout. One request per second.
 */
export async function waitForHttp(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      let res = await fetch(url, { method: "HEAD" });
      if (res.status === 405) res = await fetch(url, { method: "GET" });
      if (res.ok || (res.status >= 300 && res.status < 400)) return true;
    } catch {
      // Connection refused / DNS / etc — keep polling.
    }
    await delay(1000);
  }
  return false;
}

/**
 * Open a URL in the user's default browser. Thin wrapper over `open`
 * that swallows errors — on a headless host (SSH / container / CI)
 * there's no browser to open and that's fine; the URL is already
 * printed in the caller's outro.
 */
export async function openBrowser(url: string): Promise<void> {
  try {
    const { default: open } = await import("open");
    await open(url);
  } catch {
    // Headless / no GUI — user sees the URL in the terminal outro.
  }
}
