// SPDX-License-Identifier: Apache-2.0

/**
 * Sidecar logger writing the shared pino-shaped line (`@appstrate/core/log-line`),
 * pino-free so the compiled binary stays lean.
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
 * A test-owned sink isolates JSON log lines from other writers in the shared Bun test process.
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
