// SPDX-License-Identifier: Apache-2.0

/**
 * Appstrate-backed container-delegating runner — drives a {@link RunAdapter}
 * (typically {@link PiAdapter}), forwards every {@link RunEvent} it yields
 * to an {@link AppstrateEventSink}, and returns the reduced {@link RunResult}
 * the runtime contract produces.
 *
 * The runner intentionally knows nothing about Docker, sidecar pools, or
 * PromptContext assembly — those stay inside the adapter. The contract is:
 *
 *   adapter.execute(...) ──yields RunEvent──► sink.handle(event)
 *                        ──collected──────► reduceRunEvents ► RunResult
 *                                         ──► sink.finalize(result)
 *
 * A `plan` (PromptContext + timeout + optional package/files) is handed to
 * the adapter at run-time; the caller (typically the run route) is
 * responsible for building it before constructing the runner.
 */

import type { RunEvent } from "@appstrate/afps-runtime/types";
import { reduceRunEvents, type RunResult } from "@appstrate/afps-runtime/runner";
import type { PromptContext, RunAdapter, UploadedFile } from "./types.ts";
import type { AppstrateEventSink } from "./appstrate-event-sink.ts";

export interface ContainerRunPlan {
  promptContext: PromptContext;
  /** Optional pre-packaged agent bundle (ZIP) injected into the container. */
  agentPackage?: Buffer;
  /** Seconds cap on container lifetime. */
  timeout: number;
  /** Files materialised inside the container workspace. */
  inputFiles?: UploadedFile[];
}

export interface AppstrateContainerRunnerOptions {
  adapter: RunAdapter;
  plan: ContainerRunPlan;
}

export interface RunContainerArgs {
  runId: string;
  sink: AppstrateEventSink;
  signal?: AbortSignal;
}

export class AppstrateContainerRunner {
  readonly name = "appstrate-container-runner";

  private readonly adapter: RunAdapter;
  private readonly plan: ContainerRunPlan;

  constructor(opts: AppstrateContainerRunnerOptions) {
    this.adapter = opts.adapter;
    this.plan = opts.plan;
  }

  async run({ runId, sink, signal }: RunContainerArgs): Promise<RunResult> {
    signal?.throwIfAborted();

    const events: RunEvent[] = [];

    try {
      for await (const event of this.adapter.execute(
        runId,
        this.plan.promptContext,
        this.plan.timeout,
        this.plan.agentPackage,
        signal,
        this.plan.inputFiles,
      )) {
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
      const result = reduceRunEvents(events, {
        error: { message, stack: err instanceof Error ? err.stack : undefined },
      });
      await sink.finalize(result);
      return result;
    }

    const result = reduceRunEvents(events);
    await sink.finalize(result);
    return result;
  }
}
