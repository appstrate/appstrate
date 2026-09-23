// SPDX-License-Identifier: Apache-2.0

/**
 * One pino-compatible JSON log line — numeric `level` on pino's scale,
 * epoch-ms `time`, `msg`, then structured fields — the shape
 * `@appstrate/core/logger` writes, so a collector filtering `level >= 40`
 * keeps it. For the processes that must not carry pino (the Pi runner, the
 * agent entrypoint, the sidecar binary): one formatter, so none of them can
 * invent a second shape.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

/** pino's numeric levels (`pino.levels.values`). */
export const PINO_LEVELS: Record<LogLevel, number> = { debug: 20, info: 30, warn: 40, error: 50 };

/** The line, newline-terminated. */
export function formatLogLine(
  level: LogLevel,
  msg: string,
  data?: Record<string, unknown>,
): string {
  const line = { level: PINO_LEVELS[level], time: Date.now(), msg, ...(data ?? {}) };
  return `${JSON.stringify(line)}\n`;
}
