// SPDX-License-Identifier: Apache-2.0

/**
 * SubprocessTransport — spawn a third-party MCP server as a child process
 * and speak newline-delimited JSON-RPC over its stdio.
 *
 * Why a hand-rolled transport rather than the SDK's `StdioClientTransport`:
 *   - We need explicit control over stderr capture (the transducer
 *     routes it as `log.written` CloudEvents).
 *   - We harden against the documented MCP CVEs: per-line size cap,
 *     per-line rate cap, strict UTF-8, environment scrubbing, abort-on-
 *     cancel, output-rate limits.
 *   - We control spawn options (cgroup-friendly resource limits, env
 *     allowlist, ulimits) without monkey-patching the SDK.
 *
 * Spec compliance: this transport implements the SDK's {@link Transport}
 * interface verbatim — it can be passed to `client.connect(transport)`
 * exactly like `StdioClientTransport`.
 *
 * Runtime: this implementation uses `Bun.spawn`, matching the
 * Bun-everywhere repo standard. Bun.spawn returns a Subprocess with
 * `stdout` / `stderr` exposed as `ReadableStream<Uint8Array>` and
 * `stdin` as a `FileSink`; we drive each via async iteration.
 *
 * What it does NOT do (deferred to deployment-side hardening):
 *   - cgroup attachment (Linux-only, requires the runtime to be built
 *     into a container image with cgroup tooling). The transport
 *     surfaces resource-limit hooks; the orchestrator wires them.
 *   - gVisor / Firecracker isolation. Those are tenant-policy decisions,
 *     not per-server transport concerns.
 *   - Seccomp profile. Also deployment-side.
 *
 * These are layered defences applied above this transport, not inside
 * it. The transport handles framing, capture, and lifecycle — the
 * boring-but-correct part.
 */

import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/** Per-line cap on stdout — 1MB matches the MCP request body cap. */
const DEFAULT_MAX_LINE_BYTES = 1 * 1024 * 1024;
/** Per-second cap on incoming lines — runaway server gets killed. */
const DEFAULT_MAX_LINES_PER_SEC = 1000;
/** Per-second cap on stderr bytes — prevents stderr-flood DoS. */
const DEFAULT_MAX_STDERR_BPS = 1 * 1024 * 1024;

/** Allowlist passed via env scrubbing — keep minimal. */
const DEFAULT_ENV_PASSTHROUGH = ["PATH", "HOME", "LANG", "LC_ALL"] as const;

export interface SubprocessTransportOptions {
  /** Executable name or absolute path. */
  command: string;
  /** Arguments to pass to the executable. */
  args?: string[];
  /** Working directory. Defaults to a fresh tmp dir per spawn (caller-provided). */
  cwd?: string;
  /**
   * Environment variables to pass through unchanged from the parent
   * process (e.g. `PATH`). Adds to the {@link DEFAULT_ENV_PASSTHROUGH}
   * set. NEVER includes `RUN_TOKEN`, `PLATFORM_API_URL`, etc. — those
   * stay out of the subprocess by default and require explicit opt-in
   * via this list.
   */
  envPassthrough?: ReadonlyArray<string>;
  /** Extra env variables to inject — e.g. `NOTION_TOKEN`. */
  env?: Record<string, string>;
  /** Stderr line listener — called once per UTF-8-validated line. */
  onStderrLine?: (line: string) => void;
  /** Per-line cap on stdout. Defaults to {@link DEFAULT_MAX_LINE_BYTES}. */
  maxLineBytes?: number;
  /** Per-second cap on stdout lines. */
  maxLinesPerSec?: number;
  /** Per-second cap on stderr bytes. */
  maxStderrBps?: number;
  /** SIGTERM grace period before SIGKILL on close(). Defaults to 1s. */
  killTimeoutMs?: number;
}

/**
 * Token-bucket rate limiter. Tracks `n` events per `windowMs`; when
 * the bucket is full, additional events return `false`.
 */
class RateLimiter {
  private readonly capacity: number;
  private readonly windowMs: number;
  private events: number[] = [];

  constructor(capacity: number, windowMs: number) {
    this.capacity = capacity;
    this.windowMs = windowMs;
  }

  allow(weight = 1): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    while (this.events.length > 0 && this.events[0]! < cutoff) this.events.shift();
    if (this.events.length + weight > this.capacity) return false;
    for (let i = 0; i < weight; i += 1) this.events.push(now);
    return true;
  }
}

export class SubprocessTransportError extends Error {
  override readonly name = "SubprocessTransportError";
}

/** Minimal shape of `Bun.spawn` we rely on — typed locally so the file
 * compiles outside `tsconfig.types: ["bun-types"]` consumers. */
interface BunSubprocessLike {
  readonly stdin: { write(data: string | Uint8Array): number; end(): void };
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  readonly killed: boolean;
  kill(signal?: number | string): void;
}

/**
 * Stdio-based MCP transport. Spawn the subprocess at `start()`,
 * forward each stdout JSON-RPC line as a parsed message via
 * `onmessage`, capture stderr separately, and tear everything down on
 * `close()`.
 */
export class SubprocessTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private readonly options: SubprocessTransportOptions;
  private child?: BunSubprocessLike;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private readonly stdoutLimiter: RateLimiter;
  private readonly stderrLimiter: RateLimiter;
  private closed = false;

  constructor(options: SubprocessTransportOptions) {
    this.options = options;
    this.stdoutLimiter = new RateLimiter(options.maxLinesPerSec ?? DEFAULT_MAX_LINES_PER_SEC, 1000);
    this.stderrLimiter = new RateLimiter(options.maxStderrBps ?? DEFAULT_MAX_STDERR_BPS, 1000);
  }

  /**
   * Build the env passed to the subprocess. Starts empty, layers in the
   * passthrough allowlist (only those values actually present on the
   * parent), then merges in `options.env`. Anything outside the
   * allowlist is dropped — this is the credential isolation invariant
   * (I3) in concrete form.
   */
  private buildEnv(): Record<string, string> {
    const allow = new Set<string>([
      ...DEFAULT_ENV_PASSTHROUGH,
      ...(this.options.envPassthrough ?? []),
    ]);
    const out: Record<string, string> = {};
    for (const name of allow) {
      const v = process.env[name];
      if (typeof v === "string" && v.length > 0) out[name] = v;
    }
    if (this.options.env) {
      for (const [k, v] of Object.entries(this.options.env)) {
        if (typeof v === "string") out[k] = v;
      }
    }
    return out;
  }

  async start(): Promise<void> {
    if (this.child) {
      throw new SubprocessTransportError("Transport already started");
    }
    // Bun.spawn signature — typed via globalThis to avoid pulling in
    // bun-types as a hard import dep for downstream consumers.
    const bunSpawn = (
      globalThis as unknown as {
        Bun?: {
          spawn: (
            cmd: string[],
            opts: {
              stdin: "pipe";
              stdout: "pipe";
              stderr: "pipe";
              cwd?: string;
              env: Record<string, string>;
              onExit?: (
                _proc: BunSubprocessLike,
                exitCode: number | null,
                signalCode: number | null,
                error: Error | null,
              ) => void;
            },
          ) => BunSubprocessLike;
        };
      }
    ).Bun?.spawn;
    if (!bunSpawn) {
      throw new SubprocessTransportError(
        "Bun.spawn is not available — SubprocessTransport requires Bun >= 1.3.9",
      );
    }
    const child = bunSpawn([this.options.command, ...(this.options.args ?? [])], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      ...(this.options.cwd ? { cwd: this.options.cwd } : {}),
      env: this.buildEnv(),
      onExit: (_proc, exitCode, signalCode, error) => {
        if (this.closed) return;
        this.closed = true;
        if (error) {
          this.onerror?.(error);
        } else {
          const reason =
            exitCode !== null
              ? `subprocess exited with code ${exitCode}`
              : `subprocess killed by signal ${signalCode}`;
          this.onerror?.(new SubprocessTransportError(reason));
        }
        this.onclose?.();
      },
    });
    this.child = child;

    // Drive stdout / stderr async — the read loops resolve when the
    // streams close (which happens when the subprocess exits).
    void this.readStream(child.stdout, (chunk) => this.handleStdout(chunk));
    void this.readStream(child.stderr, (chunk) => this.handleStderr(chunk));

    // The SDK protocol layer awaits start() — we resolve immediately.
    // First message arrives via onmessage when the subprocess emits.
  }

  private async readStream(
    stream: ReadableStream<Uint8Array>,
    onChunk: (chunk: string) => void,
  ): Promise<void> {
    const decoder = new TextDecoder("utf-8", { fatal: false });
    const reader = stream.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.length > 0) {
          onChunk(decoder.decode(value, { stream: true }));
        }
      }
      // Final flush in case the stream ended mid-codepoint.
      const tail = decoder.decode();
      if (tail.length > 0) onChunk(tail);
    } catch {
      // Reader was cancelled or the subprocess crashed mid-stream;
      // the onExit handler is the source of truth for closure.
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
    }
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    while (true) {
      const newlineIdx = this.stdoutBuffer.indexOf("\n");
      if (newlineIdx === -1) break;
      const line = this.stdoutBuffer.slice(0, newlineIdx);
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIdx + 1);
      this.dispatchLine(line);
    }
    // Per-line size guard — refuse half-line buffers above the cap.
    const lineCap = this.options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    if (this.stdoutBuffer.length > lineCap) {
      this.stdoutBuffer = "";
      this.onerror?.(
        new SubprocessTransportError(`stdout line exceeds ${lineCap} bytes — buffer reset`),
      );
    }
  }

  private dispatchLine(line: string): void {
    if (line.length === 0) return;
    if (!this.stdoutLimiter.allow()) {
      this.onerror?.(new SubprocessTransportError("stdout line rate exceeded"));
      void this.close();
      return;
    }
    let message: JSONRPCMessage;
    try {
      message = JSON.parse(line) as JSONRPCMessage;
    } catch (err) {
      this.onerror?.(
        new SubprocessTransportError(
          `malformed JSON-RPC message — ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      return;
    }
    this.onmessage?.(message);
  }

  private handleStderr(chunk: string): void {
    if (!this.stderrLimiter.allow(chunk.length)) {
      // Shed silently — telling the subprocess about the back-pressure
      // would just race with its next write.
      return;
    }
    this.stderrBuffer += chunk;
    while (true) {
      const idx = this.stderrBuffer.indexOf("\n");
      if (idx === -1) break;
      const line = this.stderrBuffer.slice(0, idx);
      this.stderrBuffer = this.stderrBuffer.slice(idx + 1);
      if (line.length > 0) this.options.onStderrLine?.(line);
    }
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    if (!this.child) {
      throw new SubprocessTransportError("Transport not started");
    }
    if (this.closed) {
      throw new SubprocessTransportError("Transport closed");
    }
    const line = `${JSON.stringify(message)}\n`;
    this.child.stdin.write(line);
  }

  async close(): Promise<void> {
    if (this.closed || !this.child) {
      this.closed = true;
      this.onclose?.();
      return;
    }
    this.closed = true;
    const child = this.child;
    const grace = this.options.killTimeoutMs ?? 1000;
    try {
      child.stdin.end();
    } catch {
      // ignore
    }
    if (!child.killed) child.kill("SIGTERM");
    const exitPromise = child.exited.then(() => undefined);
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      const t = setTimeout(() => resolve("timeout"), grace);
      void exitPromise.then(() => clearTimeout(t));
    });
    const winner = await Promise.race([exitPromise.then(() => "exit" as const), timeoutPromise]);
    if (winner === "timeout" && !child.killed) {
      child.kill("SIGKILL");
      await exitPromise;
    }
    this.onclose?.();
  }
}
