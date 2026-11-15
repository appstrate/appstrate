// SPDX-License-Identifier: Apache-2.0

/**
 * Stdio handshake probe for a local integration's bundled MCP server.
 *
 * Writes every file of the integration archive into a temp directory, spawns the
 * entry point under Bun with a minimal non-secret environment, performs the MCP
 * `initialize` → `tools/list` handshake and reports the live tool names. Never
 * throws: the result encodes the outcome. Time-boxed (default 10s).
 */

import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

/** Outcome of one probe. */
export interface LocalServerProbeResult {
  ok: boolean;
  reason?: string;
  toolCount?: number;
  toolNames?: string[];
  durationMs?: number;
}

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

/** Hard wall-clock budget of one probe. */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * Write every file of the integration archive into a temp directory and
 * run the probe against its entry point. Accepting the file map directly avoids
 * round-tripping through a real ZIP just to run the probe.
 */
export async function probeLocalServer(
  files: Record<string, Uint8Array>,
  entryPoint: string,
): Promise<LocalServerProbeResult> {
  const startedAt = performance.now();

  const workDir = await mkdtemp(join(tmpdir(), "appstrate-conformance-probe-"));
  try {
    // Materialise the relevant subset on disk (Bun.write creates parent dirs).
    for (const [rel, bytes] of Object.entries(files)) {
      await Bun.write(join(workDir, rel), bytes);
    }
    const cleanEntry = entryPoint.replace(/^\.\//, "");
    const entryAbs = join(workDir, cleanEntry);

    return await runProbe(entryAbs, startedAt);
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

async function runProbe(entryAbs: string, startedAt: number): Promise<LocalServerProbeResult> {
  const withDuration = (r: LocalServerProbeResult): LocalServerProbeResult => ({
    ...r,
    durationMs: Math.round(performance.now() - startedAt),
  });

  let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    proc = Bun.spawn(["bun", entryAbs], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      // SECURITY: never forward the full process.env to third-party MCP
      // code — pass only a minimal, non-secret system allowlist.
      env: buildProbeEnv(),
    });
  } catch (err) {
    return withDuration({
      ok: false,
      reason: `failed to spawn bun: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  const writeLine = (obj: unknown): void => {
    try {
      // `FileSink.write`/`flush` return `number | Promise<number>`: a write the
      // pipe cannot take yet settles LATER, so a broken pipe reported that way
      // never reaches the sync `catch` below — it would surface as an unhandled
      // rejection instead of the ignored failure this block intends. Handle
      // both paths identically; the stdout-scan/exit path is what reports it.
      void Promise.resolve(proc.stdin.write(JSON.stringify(obj) + "\n")).catch(() => {});
      void Promise.resolve(proc.stdin.flush()).catch(() => {});
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
  const scan = async (): Promise<LocalServerProbeResult> => {
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

  const timeout = new Promise<LocalServerProbeResult>((resolve) => {
    const timer = setTimeout(
      () => resolve({ ok: false, reason: `probe timed out after ${PROBE_TIMEOUT_MS}ms` }),
      PROBE_TIMEOUT_MS,
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
      clientInfo: { name: "appstrate-conformance-probe", version: "0.0.0" },
    },
  });

  try {
    return withDuration(await Promise.race([scan(), timeout]));
  } finally {
    killProc();
  }
}
