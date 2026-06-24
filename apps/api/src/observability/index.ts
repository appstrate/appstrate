// SPDX-License-Identifier: Apache-2.0

/**
 * Observability barrel — OpenTelemetry bootstrap, span/metric helpers, and the
 * HTTP server-span middleware. See `./otel.ts` for the design contract (no-op
 * when disabled, single AsyncLocalStorage, collector-agnostic OTLP export).
 */

export {
  initObservability,
  shutdownObservability,
  setQueueDepthProvider,
  runWithSpan,
  currentTraceparent,
  recordRunDuration,
  recordRunTerminal,
  recordContainerSpawn,
  recordLlmLatency,
  recordProcessAnomaly,
} from "./otel.ts";

export { observability } from "./middleware.ts";
