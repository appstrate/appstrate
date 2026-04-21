// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

export { type BundleRunner, type RunBundleOptions } from "./types.ts";
export { type Runner, type RunOptions } from "./options.ts";
export {
  reduceRunEvents,
  emptyRunResult as emptyRunResultFromRunEvents,
  type ReduceRunEventsOptions,
} from "./run-event-reducer.ts";
export { MockRunner, type MockRunnerOptions } from "./mock.ts";
export { reduceEvents, emptyRunResult, type ReduceOptions } from "./reducer.ts";
// Re-exported for ergonomics: runners produce RunResult, so consumers
// typically import it alongside BundleRunner / reduceEvents.
export type { RunResult, RunError, LogEntry } from "../types/run-result.ts";
export {
  PiRunner,
  type PiRunnerOptions,
  type PiModelConfig,
  type PiModelApi,
  type PiSessionFactory,
  type PiSessionFactoryArgs,
  type PiSessionHandle,
} from "./pi.ts";
export {
  registerAfpsTools,
  type AfpsEventEmitter,
  type AfpsToolParameters,
  type AfpsToolsOptions,
  type PiExtensionRegistrar,
  type PiToolConfig,
  type PiToolExecuteResult,
} from "./pi-tools.ts";
