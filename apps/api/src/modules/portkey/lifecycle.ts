// SPDX-License-Identifier: Apache-2.0

/**
 * Portkey sub-process lifecycle — spawn at module `init()`, kill at
 * module `shutdown()`.
 *
 * The smoke tests (`/tmp/portkey-smoke/`) confirmed Portkey itself does
 * NOT drain in-flight streams on SIGTERM; the parent (apps/api) must
 * drain runs BEFORE shutting the module down. The existing shutdown
 * pipeline already does this — see `apps/api/src/lib/shutdown.ts`,
 * which calls `waitForInFlight()` (line ~45) BEFORE `shutdownModules()`
 * (line ~69). So this module just needs to terminate the process when
 * its `shutdown()` is invoked.
 *
 * Boot stdout is piped so we can detect the "Ready" line and only
 * resolve the init promise once Portkey is actually serving requests —
 * otherwise a fast run could fire before the gateway is listening.
 */

import { spawn, type Subprocess } from "bun";
import { createRequire } from "node:module";
import { logger } from "../../lib/logger.ts";

const READY_PATTERN = /Ready for connections!/;
const READY_TIMEOUT_MS = 15_000;

let _proc: Subprocess | null = null;
let _port: number | null = null;

interface StartOpts {
  /** Port Portkey binds to (`127.0.0.1:<port>`). */
  port: number;
}

/**
 * Spawn the Portkey gateway as a Bun sub-process and resolve once the
 * "Ready for connections" line lands on stdout. Throws if Portkey exits
 * during boot or does not become ready inside {@link READY_TIMEOUT_MS}.
 *
 * Idempotent: a second call when a process is already running is a
 * no-op. `init()` runs once per process; the test harness exercises the
 * idempotent path when modules are re-resolved.
 */
export async function startPortkey(opts: StartOpts): Promise<void> {
  if (_proc) return;

  const require = createRequire(import.meta.url);
  const portkeyBin = require.resolve("@portkey-ai/gateway/build/start-server.js");

  // Portkey reads the bind port from its `--port=<n>` CLI flag, not from
  // the PORT env var (default 8787 baked in). Pass both for belt-and-
  // braces — env var is also picked up by Bun's own `serve()` adapters on
  // some Portkey versions.
  const proc = spawn({
    cmd: ["bun", portkeyBin, `--port=${opts.port}`],
    env: { ...process.env, PORT: String(opts.port) },
    stdout: "pipe",
    stderr: "pipe",
  });

  _proc = proc;
  _port = opts.port;

  // Read stdout line-stream until either "Ready for connections!" lands
  // or the process exits. Bun's `proc.stdout` is a ReadableStream<Uint8Array>.
  const ready = new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const ok = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const timeout = setTimeout(() => {
      fail(
        new Error(`Portkey did not become ready within ${READY_TIMEOUT_MS}ms (port ${opts.port})`),
      );
    }, READY_TIMEOUT_MS);

    proc.exited
      .then((code) => {
        clearTimeout(timeout);
        if (!settled) {
          fail(new Error(`Portkey exited during boot with code ${code}`));
        }
      })
      .catch(() => {});

    (async () => {
      const decoder = new TextDecoder();
      const reader = proc.stdout.getReader();
      let buf = "";
      try {
        while (!settled) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          if (READY_PATTERN.test(buf)) {
            clearTimeout(timeout);
            ok();
            break;
          }
          // Bound the buffer — Portkey prints spinner frames during boot.
          if (buf.length > 16 * 1024) buf = buf.slice(-4 * 1024);
        }
      } catch (err) {
        fail(err as Error);
      } finally {
        reader.releaseLock();
      }
    })();
  });

  try {
    await ready;
    // The "Ready for connections!" stdout line is printed before Hono's
    // `serve()` resolves its bind promise on some Bun versions, so a fast
    // run can hit the port a few ms before the listener is wired. Poll
    // the root once with a short retry window — the connect attempt
    // succeeds within ~50 ms once the bind lands. Anything beyond 2 s
    // points to a real startup failure that the stdout-based detector
    // should have already caught.
    const READY_POLL_DEADLINE = Date.now() + 2_000;
    while (Date.now() < READY_POLL_DEADLINE) {
      try {
        const probe = await fetch(`http://127.0.0.1:${opts.port}/`);
        await probe.body?.cancel();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    logger.info("Portkey gateway ready", { port: opts.port });
  } catch (err) {
    // Failed boot — make sure we don't leak a dangling sub-process.
    try {
      proc.kill("SIGKILL");
    } catch {
      // proc may already be dead
    }
    _proc = null;
    _port = null;
    throw err;
  }
}

/**
 * Send SIGTERM to the Portkey sub-process and wait up to 3 s for clean
 * exit, then SIGKILL. Idempotent.
 *
 * Called from the module's `shutdown()` — by which point the parent has
 * already drained in-flight runs (see `apps/api/src/lib/shutdown.ts`).
 */
export async function stopPortkey(): Promise<void> {
  const proc = _proc;
  if (!proc) return;
  _proc = null;
  _port = null;

  try {
    proc.kill("SIGTERM");
  } catch {
    // Already dead — proceed.
  }

  const SIGKILL_TIMEOUT_MS = 3_000;
  const exitRace = await Promise.race([
    proc.exited.then((code) => ({ kind: "exited" as const, code })),
    new Promise<{ kind: "timeout" }>((resolve) =>
      setTimeout(() => resolve({ kind: "timeout" }), SIGKILL_TIMEOUT_MS),
    ),
  ]);

  if (exitRace.kind === "timeout") {
    logger.warn("Portkey did not exit within 3s, sending SIGKILL");
    try {
      proc.kill("SIGKILL");
    } catch {
      // Already dead
    }
    await proc.exited;
  }
}

/** Port Portkey is currently listening on, or null when not running. */
export function getPortkeyPort(): number | null {
  return _port;
}

/** @internal test helper — exposes the underlying Subprocess for assertions. */
export function _getPortkeyProcessForTesting(): Subprocess | null {
  return _proc;
}
