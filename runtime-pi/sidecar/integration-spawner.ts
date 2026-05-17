// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 1.2c — wires {@link SpawnCommandPlan} (pure, from
 * `@appstrate/connect/integration-runtime`) into the runtime via
 * `Bun.spawn`. Produces a {@link ChildHandle} the supervisor consumes
 * plus stdio streams the MCP client wires on top.
 *
 * Why a thin adapter and not a full transport: the supervisor restart
 * loop spawns a *new* subprocess on every attempt. Each spawn produces
 * a fresh stdio quartet. The MCP client (created elsewhere) needs
 * direct access to the live streams of the current attempt — so we
 * expose them on the handle rather than buffering through a wrapping
 * layer that would have to track restart epochs.
 *
 * Boundaries (deliberately deferred to 1.2d/1.3):
 *   - HTTPS MITM listener (per-host SNI + re-encrypt) is a separate
 *     module — this file does not start the proxy.
 *   - MCP client re-attach on restart is owned by the orchestrator, not
 *     here. We just spawn + expose; rewiring belongs upstairs.
 */

import type { ChildHandle } from "@appstrate/connect";
import type { SpawnCommandPlan } from "@appstrate/connect";

/**
 * Minimal `Bun.spawn` subprocess shape used by the adapter. Typed
 * locally so this file compiles without `bun-types` in consumers.
 */
export interface BunSubprocessLike {
  readonly stdin: { write(data: string | Uint8Array): number; end(): void };
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  readonly killed: boolean;
  readonly pid?: number;
  kill(signal?: number | string): void;
}

/**
 * Minimal `Bun.spawn` call signature (the subset we use). Pulled to a
 * named type so tests can inject a stub.
 */
export type BunSpawnFn = (
  cmd: string[],
  opts: {
    stdin: "pipe";
    stdout: "pipe";
    stderr: "pipe";
    cwd?: string;
    env: Record<string, string>;
    onExit?: (
      proc: BunSubprocessLike,
      exitCode: number | null,
      signalCode: number | null,
      error: Error | null,
    ) => void;
  },
) => BunSubprocessLike;

export interface SpawnIntegrationOptions {
  /** Process cwd. Defaults to undefined (inherits parent cwd). */
  cwd?: string;
  /**
   * Env passthrough allowlist — names present on parent that should be
   * forwarded as-is. Layered BEFORE `plan.env` so the plan wins on
   * collision. Defaults to `[]` (zero passthrough — caller is expected
   * to carry over PATH etc. explicitly in `plan.env`).
   */
  envPassthrough?: readonly string[];
  /**
   * SIGTERM grace period before SIGKILL on `kill()`. Default 10s,
   * mirrors `SubprocessTransport.killTimeoutMs` (spec §5.4.2).
   */
  killTimeoutMs?: number;
  /** Injectable `Bun.spawn` for tests. Defaults to `globalThis.Bun.spawn`. */
  spawn?: BunSpawnFn;
}

/**
 * Extended handle that carries the live subprocess + stdio streams the
 * MCP client wires JSON-RPC on top of. Structurally compatible with
 * {@link ChildHandle} (the supervisor only sees `exited` + `kill`).
 */
export interface SpawnedChildHandle extends ChildHandle {
  /** The raw subprocess. Owners must not call `kill` on it directly — go through `kill(reason)`. */
  readonly subprocess: BunSubprocessLike;
  /** Stdin pipe — JSON-RPC requests get written here. */
  readonly stdin: { write(data: string | Uint8Array): number; end(): void };
  /** Stdout stream — newline-delimited JSON-RPC responses. */
  readonly stdout: ReadableStream<Uint8Array>;
  /** Stderr stream — surface to telemetry. */
  readonly stderr: ReadableStream<Uint8Array>;
  /** PID for diagnostics (may be undefined in tests). */
  readonly pid?: number;
}

export class IntegrationSpawnError extends Error {
  override readonly name = "IntegrationSpawnError";
}

/**
 * Spawn a single integration MCP server. Returns a {@link SpawnedChildHandle}
 * the orchestrator hands to {@link superviseProcess}.
 *
 * The handle resolves `exited`:
 *   - `{kind: "normal-exit", code}` when the process exits with a code.
 *   - `{kind: "signal", signal}` when killed by a signal.
 *   - `{kind: "error", error}` when Bun.spawn's onExit reports an Error.
 *
 * `kill(reason)` sends SIGTERM then escalates to SIGKILL after
 * `killTimeoutMs`. Reason is currently informational (could be wired
 * to telemetry by a later iteration).
 */
export function spawnIntegrationProcess(
  plan: SpawnCommandPlan,
  options: SpawnIntegrationOptions = {},
): SpawnedChildHandle {
  const spawn = options.spawn ?? resolveBunSpawn();
  const env = buildEnv(plan.env, options.envPassthrough ?? []);

  let resolveExited!: (
    exit:
      | { kind: "normal-exit"; code: number }
      | { kind: "signal"; signal: string }
      | { kind: "error"; error: unknown },
  ) => void;
  const exited = new Promise<
    | { kind: "normal-exit"; code: number }
    | { kind: "signal"; signal: string }
    | { kind: "error"; error: unknown }
  >((res) => {
    resolveExited = res;
  });

  const proc = spawn([plan.command, ...plan.args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env,
    onExit: (_proc, exitCode, signalCode, error) => {
      if (error) {
        resolveExited({ kind: "error", error });
      } else if (exitCode !== null) {
        resolveExited({ kind: "normal-exit", code: exitCode });
      } else if (signalCode !== null) {
        resolveExited({ kind: "signal", signal: String(signalCode) });
      } else {
        // Should not happen — Bun guarantees exactly one of exitCode/signalCode.
        resolveExited({
          kind: "error",
          error: new IntegrationSpawnError("onExit fired with no code or signal"),
        });
      }
    },
  });

  const grace = options.killTimeoutMs ?? 10_000;
  let killScheduled = false;
  let processExited = false;
  void proc.exited.then(
    () => {
      processExited = true;
    },
    () => {
      processExited = true;
    },
  );

  const handle: SpawnedChildHandle = {
    exited,
    subprocess: proc,
    stdin: proc.stdin,
    stdout: proc.stdout,
    stderr: proc.stderr,
    ...(typeof proc.pid === "number" ? { pid: proc.pid } : {}),
    kill(_reason: string): void {
      if (killScheduled || processExited) return;
      killScheduled = true;
      try {
        proc.stdin.end();
      } catch {
        // ignore
      }
      try {
        proc.kill("SIGTERM");
      } catch {
        // ignore — already exited
      }
      // Escalate after grace if the process hasn't exited yet. `killed`
      // flips true the moment kill() returns (Bun semantics), so we
      // gate on the actual `exited` promise resolution instead.
      const t = setTimeout(() => {
        if (!processExited) {
          try {
            proc.kill("SIGKILL");
          } catch {
            // ignore
          }
        }
      }, grace);
      // Don't hold the event loop open waiting on grace.
      (t as unknown as { unref?: () => void }).unref?.();
      void proc.exited.then(() => clearTimeout(t));
    },
  };

  return handle;
}

/**
 * Build a spawn-time {@link superviseProcess}-compatible factory from a
 * {@link SpawnCommandPlan}. The supervisor will call this once per
 * attempt, and each call spawns a fresh subprocess. Use this directly
 * as `spawn` in {@link IntegrationSpawnRequest}.
 *
 * The factory also accepts an optional `onSpawn` callback so the
 * caller can wire the MCP client to the *current* attempt's stdio
 * (the live streams change on every restart).
 */
export function makeSupervisedSpawnFactory(
  plan: SpawnCommandPlan,
  options: SpawnIntegrationOptions & {
    /** Called synchronously after each successful spawn with the new handle. */
    onSpawn?: (handle: SpawnedChildHandle) => void;
  } = {},
): () => Promise<SpawnedChildHandle> {
  const { onSpawn, ...spawnOptions } = options;
  return async () => {
    const handle = spawnIntegrationProcess(plan, spawnOptions);
    onSpawn?.(handle);
    return handle;
  };
}

// ─────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────

function buildEnv(
  planEnv: Record<string, string>,
  passthrough: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of passthrough) {
    const v = process.env[name];
    if (typeof v === "string" && v.length > 0) out[name] = v;
  }
  for (const [k, v] of Object.entries(planEnv)) {
    out[k] = v;
  }
  return out;
}

function resolveBunSpawn(): BunSpawnFn {
  const fn = (globalThis as unknown as { Bun?: { spawn?: BunSpawnFn } }).Bun?.spawn;
  if (!fn) {
    throw new IntegrationSpawnError(
      "Bun.spawn is not available — integration-spawner requires the Bun runtime",
    );
  }
  return fn;
}
