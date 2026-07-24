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
export { computeTokenCost, type TokenCost } from "./token-cost.ts";
export { runInputToText } from "./run-input-to-text.ts";
export {
  buildProgress,
  buildToolStartProgress,
  buildToolResultProgress,
  buildMetric,
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
