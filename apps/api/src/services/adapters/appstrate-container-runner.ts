// SPDX-License-Identifier: Apache-2.0

/**
 * Appstrate-backed container-delegating runner — drives a {@link RunAdapter}
 * (typically {@link PiAdapter}), forwards every {@link RunEvent} it yields
 * to an {@link AppstrateEventSink}, and returns the reduced {@link RunResult}
 * the runtime contract produces.
 *
 * The runner intentionally knows nothing about Docker, sidecar pools, or
 * plan assembly — those stay inside the adapter. The contract is:
 *
 *   adapter.execute(...) ──yields RunEvent──► sink.handle(event)
 *                        ──collected──────► reduceEvents ► RunResult
 *                                         ──► sink.finalize(result)
 *
 * The platform {@link AppstrateRunPlan} is constructor-time configuration
 * (llmConfig, providers, timeout, files, proxy). The AFPS
 * {@link ExecutionContext} is run-time input and travels through
 * {@link RunContainerArgs}.
 */

import type { RunEvent, ExecutionContext } from "@appstrate/afps-runtime/types";
import { reduceEvents, type RunResult } from "@appstrate/afps-runtime/runner";
import type { AppstrateRunPlan, RunAdapter } from "./types.ts";
import type { AppstrateEventSink } from "./appstrate-event-sink.ts";

export interface AppstrateContainerRunnerOptions {
  adapter: RunAdapter;
  plan: AppstrateRunPlan;
}

export interface RunContainerArgs {
  runId: string;
  context: ExecutionContext;
  sink: AppstrateEventSink;
  signal?: AbortSignal;
}

export class AppstrateContainerRunner {
  readonly name = "appstrate-container-runner";

  private readonly adapter: RunAdapter;
  private readonly plan: AppstrateRunPlan;

  constructor(opts: AppstrateContainerRunnerOptions) {
    this.adapter = opts.adapter;
    this.plan = opts.plan;
  }

  async run({ runId, context, sink, signal }: RunContainerArgs): Promise<RunResult> {
    signal?.throwIfAborted();

    const events: RunEvent[] = [];

    try {
      for await (const event of this.adapter.execute(runId, context, this.plan, signal)) {
        events.push(event);
        await sink.handle(event);
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
      await sink.handle(errorEvent);
      const result = reduceEvents(events, {
        error: { message, stack: err instanceof Error ? err.stack : undefined },
      });
      await sink.finalize(result);
      return result;
    }

    const result = reduceEvents(events);
    await sink.finalize(result);
    return result;
  }
}
