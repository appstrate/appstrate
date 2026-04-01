// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import pino from "pino";

/** A log function that accepts a message and optional structured data. */
export type LogFn = (msg: string, data?: Record<string, unknown>) => void;

/** Structured logger with four standard severity levels. */
export interface Logger {
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
}

/**
 * Create a Pino-based structured JSON logger.
 * @param level - Pino log level (e.g. "debug", "info", "warn", "error")
 * @returns A Logger instance with debug/info/warn/error methods
 */
export function createLogger(level: string): Logger {
  const pinoLogger = pino({ level });

  function wrap(lvl: "debug" | "info" | "warn" | "error"): LogFn {
    return (msg, data) => {
      if (data) pinoLogger[lvl](data, msg);
      else pinoLogger[lvl](msg);
    };
  }

  return {
    debug: wrap("debug"),
    info: wrap("info"),
    warn: wrap("warn"),
    error: wrap("error"),
  };
}
