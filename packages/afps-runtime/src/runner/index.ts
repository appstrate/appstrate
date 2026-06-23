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
export { finalizeFailure, type FinalizeFailureOptions } from "./finalize-failure.ts";
export { computeTokenCost, type TokenCost } from "./token-cost.ts";
export {
  runContainerLifecycle,
  RunTimeoutError,
  type WorkloadOrchestrator,
  type ContainerLifecycleOptions,
} from "./container-lifecycle.ts";
// Re-exported for ergonomics: runners produce RunResult, so consumers
// typically import it alongside the runner surface.
export type { RunResult, RunError, LogEntry, LogLevel, TokenUsage } from "../types/run-result.ts";
