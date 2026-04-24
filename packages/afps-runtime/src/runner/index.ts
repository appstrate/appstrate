// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

export { type Runner, type RunOptions } from "./types.ts";
export { reduceEvents, foldEvent, emptyRunResult, type ReduceOptions } from "./reducer.ts";
export {
  runContainerLifecycle,
  RunTimeoutError,
  type WorkloadOrchestrator,
  type ContainerLifecycleOptions,
} from "./container-lifecycle.ts";
// Re-exported for ergonomics: runners produce RunResult, so consumers
// typically import it alongside the runner surface.
export type { RunResult, RunError, LogEntry, LogLevel, TokenUsage } from "../types/run-result.ts";
