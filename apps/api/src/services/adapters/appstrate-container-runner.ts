// SPDX-License-Identifier: Apache-2.0

/**
 * Appstrate-backed {@link BundleRunner} — wraps the platform's
 * container-execution path (PiAdapter + Docker orchestrator + sidecar
 * pool) behind the runtime's BundleRunner interface so apps/api becomes
 * a regular runtime consumer.
 *
 * Architecture:
 *
 *   runtime-level                               apps/api-level
 *   ─────────────                               ─────────────
 *   BundleRunner.run(opts)   ────bridges to───► RunAdapter.execute(...)
 *     ↓                                             ↓  yields RunMessage
 *     ExecutionContext                              stream via AsyncGenerator
 *     ContextProvider           mapRunMessage →
 *     EventSink               ◄─── AfpsEvent ◄────┘
 *
 * The class intentionally does NOT know about Docker, sidecar pools, or
 * PromptContext assembly. Those stay in PiAdapter / env-builder — the
 * runner is a pure translation layer. A `buildPromptContext` factory is
 * injected by the caller (typically the run route) so the runner can
 * derive the PromptContext from the bundle + ExecutionContext it
 * receives from the runtime.
 *
 * NOTE: This is the runtime-facing contract Appstrate exposes; Phase E
 * of the parity migration also restructures what runs INSIDE the
 * container (entrypoint.ts → PiRunner + FileSink) and the route handler
 * (runs.ts → use this runner instead of driving PiAdapter directly).
 * That second half is a separate, larger cut-over.
 */

import type { BundleRunner, RunBundleOptions, RunResult } from "@appstrate/afps-runtime/runner";
import type { AfpsEvent, AfpsEventEnvelope } from "@appstrate/afps-runtime/types";
import { reduceEvents } from "@appstrate/afps-runtime/runner";
import type { PromptContext, RunAdapter, RunMessage, UploadedFile } from "./types.ts";

export interface ContainerRunPlan {
  promptContext: PromptContext;
  /** Optional pre-packaged agent bundle (ZIP) injected into the container. */
  agentPackage?: Buffer;
  /** Seconds cap on container lifetime. */
  timeout: number;
  /** Files materialised inside the container workspace. */
  inputFiles?: UploadedFile[];
}

export type BuildPromptContextFn = (opts: RunBundleOptions) => Promise<ContainerRunPlan>;

export interface AppstrateContainerRunnerOptions {
  adapter: RunAdapter;
  buildPromptContext: BuildPromptContextFn;
  /**
   * Optional hook for surfacing per-message cost / usage telemetry that
   * falls outside the AFPS event grammar. The runtime's sink only
   * observes canonical events; platform-specific metrics flow through
   * this side-channel. Default: no-op.
   */
  onPlatformMetric?: (msg: RunMessage) => void;
}

export class AppstrateContainerRunner implements BundleRunner {
  readonly name = "appstrate-container-runner";

  private readonly adapter: RunAdapter;
  private readonly buildPromptContext: BuildPromptContextFn;
  private readonly onPlatformMetric: (msg: RunMessage) => void;

  constructor(opts: AppstrateContainerRunnerOptions) {
    this.adapter = opts.adapter;
    this.buildPromptContext = opts.buildPromptContext;
    this.onPlatformMetric = opts.onPlatformMetric ?? (() => {});
  }

  async run(opts: RunBundleOptions): Promise<RunResult> {
    const { context, sink, signal } = opts;
    signal?.throwIfAborted();

    const plan = await this.buildPromptContext(opts);
    const events: AfpsEvent[] = [];
    let sequence = 0;

    const emit = async (event: AfpsEvent) => {
      events.push(event);
      const envelope: AfpsEventEnvelope = {
        runId: context.runId,
        sequence: sequence++,
        event,
      };
      await sink.onEvent(envelope);
    };

    try {
      for await (const msg of this.adapter.execute(
        context.runId,
        plan.promptContext,
        plan.timeout,
        plan.agentPackage,
        signal,
        plan.inputFiles,
      )) {
        const event = mapRunMessageToAfpsEvent(msg);
        if (event) {
          await emit(event);
        } else {
          // Non-canonical platform telemetry (usage / cost / adapter
          // diagnostics) is forwarded on the side-channel so the
          // AFPS event stream stays pure.
          this.onPlatformMetric(msg);
        }
      }
    } catch (err) {
      if (signal?.aborted) {
        // Propagate cancellation — the caller's finally block owns the
        // decision to finalize or not.
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      await emit({ type: "log", level: "error", message });
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

/**
 * Translate an internal Appstrate {@link RunMessage} into an
 * {@link AfpsEvent}. Only the 5 canonical event types cross the
 * boundary; platform-specific messages (`usage`, `error` from the
 * adapter itself) are dropped and routed through the side-channel.
 *
 * Exported for unit testing and for any caller that wants to reuse the
 * mapping outside the runner (e.g. log replay, tests).
 */
export function mapRunMessageToAfpsEvent(msg: RunMessage): AfpsEvent | null {
  switch (msg.type) {
    case "add_memory":
      return { type: "add_memory", content: msg.content ?? "" };
    case "set_state":
      return { type: "set_state", state: msg.data ?? null };
    case "output":
      return { type: "output", data: msg.data ?? null };
    case "report":
      return { type: "report", content: msg.content ?? "" };
    case "progress":
      return {
        type: "log",
        level: normaliseLogLevel(msg.level),
        message: msg.message ?? "",
      };
    case "error":
      // Adapter-level errors are surfaced as log events with level=error
      // so they reach the sink through the canonical channel. The
      // runner itself also emits a synthetic log event when the
      // adapter throws — both funnels produce the same observable
      // shape downstream.
      return { type: "log", level: "error", message: msg.message ?? "" };
    case "usage":
      return null;
  }
}

function normaliseLogLevel(level: RunMessage["level"]): "info" | "warn" | "error" {
  switch (level) {
    case "warn":
      return "warn";
    case "error":
      return "error";
    case "debug":
    case "info":
    case undefined:
      return "info";
  }
}
