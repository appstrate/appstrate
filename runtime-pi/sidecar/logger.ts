// SPDX-License-Identifier: Apache-2.0

/**
 * Minimal structured JSON logger for the sidecar, writing the shared
 * pino-compatible line (`@appstrate/core/log-line`). Kept pino-free so
 * the compiled binary stays lean — pulling `@appstrate/core/logger` would
 * transitively bring in pino + node:async_hooks, which the sidecar doesn't need.
 */

import { PINO_LEVELS, formatLogLine, type LogLevel } from "@appstrate/core/log-line";

function envLevel(): LogLevel {
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
let testSink: ((level: LogLevel, line: string) => void) | null = null;

/**
 * Redirect emitted lines to `sink`, or back to the process streams with
 * `null`. Test-only — production never calls it, and the threshold check still
 * runs first, so a sink observes exactly what would have been written.
 */
export function _setLogSinkForTesting(
  sink: ((level: LogLevel, line: string) => void) | null,
): void {
  testSink = sink;
}

function emit(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
  // Evaluated per-call (not captured at import) so `LOG_LEVEL` can be raised
  // to `debug` for diagnostics without a process restart, and so tests can
  // toggle the threshold around a single call.
  if (PINO_LEVELS[level] < PINO_LEVELS[envLevel()]) return;
  const line = formatLogLine(level, msg, data);
  if (testSink) {
    testSink(level, line);
    return;
  }
  if (level === "error" || level === "warn") {
    process.stderr.write(line);
  } else {
    process.stdout.write(line);
  }
}

export const logger = {
  debug: (msg: string, data?: Record<string, unknown>) => emit("debug", msg, data),
  info: (msg: string, data?: Record<string, unknown>) => emit("info", msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => emit("warn", msg, data),
  error: (msg: string, data?: Record<string, unknown>) => emit("error", msg, data),
};
