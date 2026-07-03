// SPDX-License-Identifier: Apache-2.0

/**
 * Small subprocess utilities shared by the subprocess-spawning
 * orchestrators (process, firecracker) and the firecracker host-net
 * executor. Deliberately boring: exactly what the current callers need,
 * no options bags beyond that.
 */

import { open as fsOpen } from "node:fs/promises";
import { createLogger } from "@appstrate/core/logger";

// Core pino logger read straight from LOG_LEVEL (default `info`), NOT the
// platform logger (apps/api/src/lib/logger.ts). This file is pulled into
// the firecracker `appstrate-runner` daemon's dependency closure (via the
// orchestrator + host-net executor), which must boot on a bare KVM host
// with only FIRECRACKER_RUNNER_* set — it cannot depend on @appstrate/env's
// required-secrets schema. Output is identical for the platform-side
// callers (process orchestrator).
const logger = createLogger(process.env.LOG_LEVEL ?? "info");

type BunProcess = ReturnType<typeof Bun.spawn>;

/** Poll interval for tailing an append-only output file (ms). */
const TAIL_POLL_MS = 50;
/** Read buffer size for tailing (bytes). */
const TAIL_BUFFER_SIZE = 16_384;
/** tailFileLines: flush a newline-less partial line once it grows past this. */
const PARTIAL_FLUSH_BYTES = 64 * 1024;

/** Lines of drained output kept when a {@link drainStream} tail is requested. */
const DRAIN_TAIL_LINES = 50;

/**
 * Tail an append-only output file, yielding complete lines until
 * `isExited()` reports the producer is gone (then the remaining partial
 * line, if any). Returns silently when the file cannot be opened — the
 * producer never started. A newline-less line is flushed as a synthetic
 * line once it exceeds {@link PARTIAL_FLUSH_BYTES} so a pathological
 * producer cannot grow the partial buffer unbounded in the API heap.
 */
export async function* tailFileLines(
  path: string,
  isExited: () => boolean,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  let fh: Awaited<ReturnType<typeof fsOpen>>;
  try {
    fh = await fsOpen(path, "r");
  } catch {
    return;
  }
  const buf = Buffer.alloc(TAIL_BUFFER_SIZE);
  const decoder = new TextDecoder();
  let partial = "";
  try {
    while (!signal?.aborted) {
      const { bytesRead } = await fh.read(buf, 0, buf.length);
      if (bytesRead > 0) {
        partial += decoder.decode(buf.subarray(0, bytesRead), { stream: true });
        const lines = partial.split("\n");
        partial = lines.pop() ?? "";
        for (const line of lines) {
          if (line.length > 0) yield line;
        }
        if (partial.length > PARTIAL_FLUSH_BYTES) {
          yield partial;
          partial = "";
        }
      } else if (isExited()) {
        if (partial.length > 0) yield partial;
        break;
      } else {
        await new Promise((r) => setTimeout(r, TAIL_POLL_MS));
      }
    }
  } finally {
    await fh.close();
  }
}

export interface CollectedProcess {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn a command, collect stdout/stderr fully, and wait for exit.
 * Non-zero exits are NOT thrown here — each caller owns its error
 * message (the host-net executor reports the unprefixed command, not
 * the sudo-wrapped argv it actually spawned).
 */
export async function spawnCollect(
  argv: string[],
  opts: { stdin?: string } = {},
): Promise<CollectedProcess> {
  const proc = Bun.spawn(argv, {
    stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : undefined,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

/**
 * Drain one output stream of a long-lived subprocess, line by line.
 * Each line is logged at warn level (`[label:stream]` prefix) for live
 * tailing; draining also keeps the pipe from filling up (Bun pipes hang
 * at ~64KB without a reader). When `opts.tail` is provided the same
 * lines are appended to it (capped at the last 50) so the platform can
 * surface them in an exit-error log even when the process dies before
 * the live warn lines reach the user's filtered view.
 *
 * Fire-and-forget: returns immediately, swallows stream errors.
 */
export function drainStream(
  proc: BunProcess,
  label: string,
  opts: { stream?: "stderr" | "stdout"; tail?: string[] } = {},
): void {
  const stream = opts.stream ?? "stderr";
  const source = stream === "stderr" ? proc.stderr : proc.stdout;
  if (!source || typeof source === "number") return;

  const reader = (source as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buf = "";

  const append = (line: string) => {
    logger.warn(`[${label}:${stream}] ${line}`);
    if (opts.tail) {
      opts.tail.push(line);
      if (opts.tail.length > DRAIN_TAIL_LINES) opts.tail.shift();
    }
  };

  const drain = async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim()) append(line);
        }
      }
      if (buf.trim()) append(buf);
    } catch {
      // Stream closed.
    } finally {
      reader.releaseLock();
    }
  };
  drain().catch(() => {});
}
