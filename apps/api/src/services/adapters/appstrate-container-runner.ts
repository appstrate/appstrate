// SPDX-License-Identifier: Apache-2.0

/**
 * Appstrate-backed {@link Runner} — conforms to the AFPS 1.3 runtime
 * surface from `@appstrate/afps-runtime/runner`. Composes a
 * {@link ContainerExecutor} (defaults to the Pi container executor) to
 * produce {@link RunEvent}s, forwards them to the caller's
 * {@link EventSink}, and finalises with the reducer-produced
 * {@link RunResult}.
 *
 *   executor(...) ──yields RunEvent──► eventSink.handle(event)
 *                 ──collected──────► reduceEvents ► RunResult
 *                                  ──► eventSink.finalize(result)
 *
 * The platform {@link AppstrateRunPlan} (llmConfig, providers, timeout,
 * files, proxy) is constructor-time configuration. The AFPS
 * {@link ExecutionContext} and runtime dependencies (bundle, sink,
 * resolvers) travel through {@link RunOptions}.
 */

import type { RunEvent } from "@appstrate/afps-runtime/types";
import {
  reduceEvents,
  type RunResult,
  type Runner,
  type RunOptions,
} from "@appstrate/afps-runtime/runner";
import type { AppstrateRunPlan } from "./types.ts";
import { createPiContainerExecutor, type ContainerExecutor } from "./pi.ts";

export interface AppstrateContainerRunnerOptions {
  plan: AppstrateRunPlan;
  /**
   * Override the container execution strategy. Defaults to
   * {@link createPiContainerExecutor} which drives a Docker Pi agent +
   * sidecar. Tests inject a scripted generator to run without Docker.
   */
  executor?: ContainerExecutor;
}

export class AppstrateContainerRunner implements Runner {
  readonly name = "appstrate-container-runner";

  private readonly executor: ContainerExecutor;
  private readonly plan: AppstrateRunPlan;

  constructor(opts: AppstrateContainerRunnerOptions) {
    this.plan = opts.plan;
    this.executor = opts.executor ?? createPiContainerExecutor();
  }

  async run(options: RunOptions): Promise<void> {
    const { context, eventSink, signal } = options;
    signal?.throwIfAborted();

    const runId = context.runId;
    const events: RunEvent[] = [];

    try {
      for await (const event of this.executor(runId, context, this.plan, signal)) {
        events.push(event);
        await eventSink.handle(event);
      }
    } catch (err) {
      if (signal?.aborted) {
        // Propagate cancellation — the caller's finally block owns the
        // decision to finalize or not.
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      const errorEvent: RunEvent = {
        type: "appstrate.error",
        timestamp: Date.now(),
        runId,
        message,
      };
      events.push(errorEvent);
      await eventSink.handle(errorEvent);
      const result = reduceEvents(events, {
        error: { message, stack: err instanceof Error ? err.stack : undefined },
      });
      await eventSink.finalize(result);
      return;
    }

    const result: RunResult = reduceEvents(events);
    await eventSink.finalize(result);
  }
}
