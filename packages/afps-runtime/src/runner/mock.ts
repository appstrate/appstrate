// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Deterministic scripted runner — replays a pre-defined list of events
 * through the sink instead of executing against a real LLM.
 *
 * Use cases:
 *
 * - Tests and conformance (the runner contract without LLM flakiness)
 * - Replay: re-emit a recorded run's event stream for debugging
 * - Offline demos and onboarding docs
 */

import { renderPrompt } from "../bundle/prompt-renderer.ts";
import type { AfpsEvent } from "../types/afps-event.ts";
import { toRunEvent } from "../types/run-event.ts";
import type { RunError, RunResult } from "../types/run-result.ts";
import { reduceEvents } from "./reducer.ts";
import type { BundleRunner, RunBundleOptions } from "./types.ts";

export interface MockRunnerOptions {
  /** Events that will be emitted verbatim through the sink, in order. */
  events: readonly AfpsEvent[];
  /** Optional error attached to the final RunResult. */
  error?: RunError;
  /**
   * When set, the rendered prompt is captured here for inspection by
   * tests. The runner still renders the prompt (exercising the template
   * path), but does not forward it anywhere itself.
   */
  onPromptRendered?: (prompt: string) => void;
  /**
   * Reference `Date.now()` replacement for deterministic log timestamps.
   * Defaults to the real clock.
   */
  nowMs?: () => number;
}

export class MockRunner implements BundleRunner {
  readonly name = "mock-runner";
  private readonly opts: MockRunnerOptions;

  constructor(opts: MockRunnerOptions) {
    this.opts = opts;
  }

  async run(options: RunBundleOptions): Promise<RunResult> {
    const { bundle, context, sink, contextProvider, signal } = options;
    signal?.throwIfAborted();

    const rendered = await renderPrompt({
      template: bundle.prompt,
      context,
      provider: contextProvider,
    });
    this.opts.onPromptRendered?.(rendered);

    const now = this.opts.nowMs ?? Date.now;
    for (const event of this.opts.events) {
      signal?.throwIfAborted();
      await sink.handle(toRunEvent({ event, runId: context.runId, nowMs: now() }));
    }

    const result = reduceEvents(this.opts.events, {
      nowMs: this.opts.nowMs,
      error: this.opts.error,
    });
    await sink.finalize(result);
    return result;
  }
}
