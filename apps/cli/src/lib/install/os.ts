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
import { createServer } from "node:net";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
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
  /**
   * Kill the child after this many ms and resolve with `ok: false`
   * (exitCode `-1`, stderr `"timeout"`). Intended for probes that must
   * not block the UI — e.g. `docker info` when the daemon is starting
   * up can hang for 10–30 s. Undefined = no timeout (legacy behaviour).
   */
  timeoutMs?: number;
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
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const settle = (r: CommandResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    if (opts.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        // SIGTERM first, then SIGKILL shortly after in case the child
        // ignores the term. We don't await — the `close` listener below
        // is already short-circuited by `settled`.
        try {
          child.kill("SIGTERM");
          setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              // already gone
            }
          }, 500).unref();
        } catch {
          // already gone
        }
        settle({ ok: false, exitCode: -1, stdout, stderr: stderr || "timeout" });
      }, opts.timeoutMs);
      timer.unref?.();
    }
    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", () => {
      // ENOENT when `cmd` is not on PATH — surface as ok:false.
      settle({ ok: false, exitCode: -1, stdout, stderr });
    });
    child.on("close", (code) => {
      const exitCode = code ?? -1;
      settle({ ok: exitCode === 0, exitCode, stdout, stderr });
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
 * Probe whether `port` is free by attempting to bind a listener on
 * `host` (default `0.0.0.0` — the wildcard IPv4 address that Docker
 * and `bun run dev` also bind to). Resolves `true` on `listening`,
 * `false` on `EADDRINUSE` (or any other bind error). The server is
 * closed immediately in both branches, so the probe is side-effect
 * free.
 *
 * Binding to `0.0.0.0` catches conflicts with anything listening on
 * the same port on any interface — which is the same scope compose /
 * the dev server will try to occupy a moment later.
 */
export function isPortAvailable(port: number, host = "0.0.0.0"): Promise<boolean> {
  // Out-of-range ports are never "available" — validate up-front so
  // callers don't get tripped up by `listen(-1)`'s platform-specific
  // behaviour (Node/Bun may treat it as "pick any port" and report the
  // bogus input as free).
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return Promise.resolve(false);
  }
  return new Promise((resolvePromise) => {
    const srv = createServer();
    srv.unref();
    const done = (ok: boolean) => {
      try {
        srv.close();
      } catch {
        // already closed
      }
      resolvePromise(ok);
    };
    srv.once("error", () => done(false));
    srv.once("listening", () => done(true));
    try {
      srv.listen(port, host);
    } catch {
      // Synchronous throw (rare — e.g. invalid port). Treat as unavailable.
      resolvePromise(false);
    }
  });
}

/**
 * Best-effort "who's holding port <port>?" probe. Runs `lsof` (macOS /
 * most Linux) then falls back to `ss` (modern Linux / musl). Returns a
 * short human description (e.g. `"node (pid 1234)"`) when it can parse
 * one, or `null` when the probe isn't available, isn't permitted, or
 * returns empty output. Never throws — the caller treats `null` as
 * "no hint, move on".
 *
 * On Windows we return `null` (PowerShell's `Get-NetTCPConnection`
 * output is too noisy to parse reliably from a cross-platform CLI).
 */
export async function describeProcessOnPort(port: number): Promise<string | null> {
  if (process.platform === "win32") return null;
  // lsof: prints a header + one line per holder. Example line:
  //   node      12345 user   23u  IPv4 0x...  0t0  TCP *:3000 (LISTEN)
  if (commandExists("lsof")) {
    const res = await runCommand("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-F", "pc"], {
      stdio: "pipe",
    });
    if (res.ok) {
      const hint = parseLsofField(res.stdout);
      if (hint) return hint;
    }
  }
  // ss: `-H` suppresses header. Example line:
  //   LISTEN 0 511 *:3000 *:* users:(("node",pid=12345,fd=22))
  if (commandExists("ss")) {
    const res = await runCommand("ss", ["-Hlntp", `sport = :${port}`], { stdio: "pipe" });
    if (res.ok) {
      const hint = parseSsOutput(res.stdout);
      if (hint) return hint;
    }
  }
  return null;
}

/** Parse `lsof -F pc` output (one field per line, `p<pid>` / `c<cmd>`). */
function parseLsofField(raw: string): string | null {
  let pid: string | undefined;
  let cmd: string | undefined;
  for (const line of raw.split("\n")) {
    if (line.startsWith("p")) pid = line.slice(1).trim();
    else if (line.startsWith("c")) cmd = line.slice(1).trim();
    if (pid && cmd) break;
  }
  if (!pid && !cmd) return null;
  if (pid && cmd) return `${cmd} (pid ${pid})`;
  return cmd ?? `pid ${pid}`;
}

/** Extract the first `users:(("name",pid=N,…))` tuple from `ss` output. */
function parseSsOutput(raw: string): string | null {
  const match = raw.match(/users:\(\("([^"]+)",pid=(\d+)/);
  if (!match) return null;
  return `${match[1]} (pid ${match[2]})`;
}

/**
 * Strict IPv4-literal check (each octet 0..255). Firecracker guests have
 * no DNS resolver, so the platform URL the runner + guests reach must be
 * an IPv4 literal — a hostname would fail inside every microVM. Mirrors
 * the intent of `IPV4_URL_RE` in `commands/runner.ts` (that one matches a
 * full URL; this one matches a bare address).
 */
const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;

export function isIpv4(value: string): boolean {
  if (!IPV4_RE.test(value)) return false;
  return value.split(".").every((octet) => {
    const n = Number(octet);
    return Number.isInteger(n) && n >= 0 && n <= 255;
  });
}

/** Private (RFC 1918) IPv4 ranges — preferred over public/other addresses. */
function isRfc1918(ip: string): boolean {
  return /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(?:1[6-9]|2\d|3[01])\./.test(ip);
}

/**
 * Best-effort detection of this host's LAN IPv4 address — the address a
 * same-host Firecracker runner daemon (and its guests) reach the platform
 * on. Walks `os.networkInterfaces()`, keeps every non-internal IPv4, and
 * prefers an RFC 1918 private address (the common LAN case) over a public
 * or link-local one. Returns `null` when no non-internal IPv4 exists
 * (loopback-only host) — the caller then prompts / requires `--host-ip`.
 *
 * `ifaces` is injectable so tests can feed a deterministic interface map
 * without depending on the runner's real network configuration.
 */
export function detectLanIpv4(
  ifaces: () => NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces,
): string | null {
  const candidates: string[] = [];
  for (const list of Object.values(ifaces())) {
    if (!list) continue;
    for (const info of list) {
      // node >= 18 reports `family` as the string "IPv4"; older/native
      // callers may hand back the numeric 4 — accept both.
      const isV4 = info.family === "IPv4" || (info.family as unknown) === 4;
      if (!isV4 || info.internal) continue;
      candidates.push(info.address);
    }
  }
  return candidates.find(isRfc1918) ?? candidates[0] ?? null;
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
