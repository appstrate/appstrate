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

const minLevel = LEVEL_VALUES[envLevel()];

function emit(level: Level, msg: string, data?: Record<string, unknown>): void {
  if (LEVEL_VALUES[level] < minLevel) return;
  const line = JSON.stringify({
    level,
    time: new Date().toISOString(),
    msg,
    ...(data ?? {}),
  });
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
