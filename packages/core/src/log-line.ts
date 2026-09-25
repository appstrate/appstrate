// SPDX-License-Identifier: Apache-2.0

/** One pino-compatible JSON log line, for processes that must not carry pino. */

export type LogLevel = "debug" | "info" | "warn" | "error";

/** pino's numeric levels (`pino.levels.values`). */
export const PINO_LEVELS: Record<LogLevel, number> = { debug: 20, info: 30, warn: 40, error: 50 };

export function formatLogLine(
  level: LogLevel,
  msg: string,
  data?: Record<string, unknown>,
): string {
  const line = { level: PINO_LEVELS[level], time: Date.now(), msg, ...(data ?? {}) };
  return `${JSON.stringify(line)}\n`;
}
