// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import pino from "pino";
import { AsyncLocalStorage } from "node:async_hooks";

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
 * Per-request trace context — when set via {@link runWithTraceContext},
 * `createLogger` mixes `trace_id` / `span_id` / `trace_flags` into every
 * subsequent log line on this async chain. Matches the OpenTelemetry
 * semantic conventions for log correlation, so a downstream collector
 * can join logs ↔ traces without reading the body shape.
 */
export interface TraceContext {
  /** Hex-encoded 32-char W3C trace-id. */
  traceId: string;
  /** Hex-encoded 16-char W3C span-id. */
  spanId?: string;
  /** Hex-encoded 2-char W3C trace-flags. */
  traceFlags?: string;
}

const traceStorage = new AsyncLocalStorage<TraceContext>();

/**
 * Run `fn` with the supplied trace context bound on the current async
 * chain. Logger calls inside `fn` (synchronous or awaited) will pick up
 * the context via the pino mixin.
 */
export function runWithTraceContext<T>(ctx: TraceContext, fn: () => T): T {
  return traceStorage.run(ctx, fn);
}

/**
 * Read the current trace context — useful when forging child spans for
 * outbound HTTP calls. Returns `undefined` outside a `runWithTraceContext`
 * scope.
 */
export function getTraceContext(): TraceContext | undefined {
  return traceStorage.getStore();
}

/**
 * Create a Pino-based structured JSON logger.
 * @param level - Pino log level (e.g. "debug", "info", "warn", "error")
 * @returns A Logger instance with debug/info/warn/error methods
 */
export function createLogger(level: string): Logger {
  const pinoLogger = pino({
    level,
    // OpenTelemetry log correlation: emit `trace_id`, `span_id`,
    // `trace_flags` on every line that's emitted inside a
    // `runWithTraceContext` scope. The mixin runs once per log call;
    // outside any trace scope the store is undefined and we emit
    // nothing, so structured-only consumers see no extra fields.
    mixin() {
      const ctx = traceStorage.getStore();
      if (!ctx) return {};
      const out: Record<string, string> = { trace_id: ctx.traceId };
      if (ctx.spanId) out.span_id = ctx.spanId;
      if (ctx.traceFlags) out.trace_flags = ctx.traceFlags;
      return out;
    },
  });

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
