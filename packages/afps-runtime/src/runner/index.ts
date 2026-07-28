// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

export { type Runner, type RunOptions } from "./types.ts";
export {
  reduceEvents,
  foldEvent,
  emptyRunResult,
  zeroTokenUsage,
  type ReduceOptions,
} from "./reducer.ts";
export { truncateToolResult, toolResultByteLimit } from "./tool-result.ts";
export {
  computeTokenCost,
  classifyTokenPricing,
  type TokenCost,
  type TokenPricingStatus,
} from "./token-cost.ts";
export {
  buildProgress,
  buildToolStartProgress,
  buildToolResultProgress,
  buildMetric,
  buildTurnProgress,
  TURN_PROGRESS_EVENT,
  buildError,
} from "./event-builders.ts";
export {
  finalizeThrownFailure,
  type FinalizeThrownFailureOptions,
} from "./finalize-thrown-failure.ts";
export { RunTimeoutError } from "../errors.ts";
// Re-exported for ergonomics: runners produce RunResult, so consumers
// typically import it alongside the runner surface.
export type {
  RunResult,
  RunArtifactsSummary,
  RunError,
  LogEntry,
  LogLevel,
  TokenUsage,
} from "../types/run-result.ts";
