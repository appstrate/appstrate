// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import type { EventSink } from "../interfaces/event-sink.ts";
import type { LoadedBundle } from "../bundle/loader.ts";
import type { ExecutionContext } from "../types/execution-context.ts";
import type { ContextProvider } from "../interfaces/context-provider.ts";
import type { RunResult } from "../types/run-result.ts";

/**
 * Execution surface: take a loaded bundle + execution context, emit
 * events to the sink, resolve with the aggregated RunResult.
 *
 * Implementations:
 *
 * - `MockRunner` — replays a scripted event list (deterministic, tests,
 *   replay, conformance adapter behaviour).
 * - `PiRunner` — invokes `@mariozechner/pi-coding-agent` and pipes its
 *   tool-emission stream into the sink. Ships as an optional subpackage
 *   so core consumers don't pull the Pi SDK unless they need it.
 *
 * The runner owns rendering the prompt, envelope construction, and
 * reducer semantics. Callers only supply the sink and context.
 */
export interface BundleRunner {
  /** Human-readable name for diagnostics and conformance reports. */
  readonly name: string;

  run(options: RunBundleOptions): Promise<RunResult>;
}

export interface RunBundleOptions {
  /** Already-loaded bundle (manifest + prompt + files). */
  bundle: LoadedBundle;
  /** Per-run execution context — runId, input, etc. */
  context: ExecutionContext;
  /** Sink receiving each event envelope plus the final RunResult. */
  sink: EventSink;
  /** Source of memories / state / history for the prompt view. */
  contextProvider: ContextProvider;
  /** Cancellation token. Runner MUST stop emitting and reject if aborted. */
  signal?: AbortSignal;
}
