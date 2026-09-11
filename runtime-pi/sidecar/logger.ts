// SPDX-License-Identifier: Apache-2.0

/**
 * Minimal structured JSON logger for the sidecar. Emits one line per call
 * to stdout/stderr in the same shape downstream collectors expect from
 * the rest of the platform (`level`, `time`, `msg`, plus arbitrary
 * structured fields). Kept dependency-free so the compiled binary stays
 * lean — pulling `@appstrate/core/logger` would transitively bring in
 * pino + node:async_hooks, which the sidecar doesn't need.
 */

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_VALUES: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function envLevel(): Level {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") return raw;
  return "info";
}

/**
 * Where emitted lines go. `null` is production: the real process streams.
 *
 * A test that wants to read what the logger emitted used to swap the *global*
 * `process.stdout.write` for the duration of a call. `bun test` runs the whole
 * repo in one process, so that buffer also collected whatever any other suite
 * or library wrote in that window — and this logger's readers parse every
 * captured line as JSON, so one foreign byte is a `SyntaxError`, not a soft
 * assertion failure (issue #1180). Routing through a sink the test owns keeps
 * the buffer to lines this logger actually produced.
 */
let testSink: ((level: Level, line: string) => void) | null = null;

/**
 * Redirect emitted lines to `sink`, or back to the process streams with
 * `null`. Test-only — production never calls it, and the threshold check still
 * runs first, so a sink observes exactly what would have been written.
 */
export function _setLogSinkForTesting(sink: ((level: Level, line: string) => void) | null): void {
  testSink = sink;
}

function emit(level: Level, msg: string, data?: Record<string, unknown>): void {
  // Evaluated per-call (not captured at import) so `LOG_LEVEL` can be raised
  // to `debug` for diagnostics without a process restart, and so tests can
  // toggle the threshold around a single call.
  if (LEVEL_VALUES[level] < LEVEL_VALUES[envLevel()]) return;
  const line = JSON.stringify({
    level,
    time: new Date().toISOString(),
    msg,
    ...(data ?? {}),
  });
  if (testSink) {
    testSink(level, line + "\n");
    return;
  }
  if (level === "error" || level === "warn") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

export const logger = {
  debug: (msg: string, data?: Record<string, unknown>) => emit("debug", msg, data),
  info: (msg: string, data?: Record<string, unknown>) => emit("info", msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => emit("warn", msg, data),
  error: (msg: string, data?: Record<string, unknown>) => emit("error", msg, data),
};
