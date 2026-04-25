// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Generic workload lifecycle: start → timeout → stream → wait → cleanup.
 *
 * Decoupled from any specific orchestrator (Docker, K8s, local process) via
 * the {@link WorkloadOrchestrator} contract. Consumers pass their own
 * orchestrator + workload handle + log processor; the helper yields the
 * resulting {@link RunEvent} stream and guarantees cleanup + timeout even
 * on cancellation.
 */

import type { RunEvent } from "@afps-spec/types";
import { RunCancelledError, RunTimeoutError, WorkloadExitError } from "../errors.ts";

export { RunTimeoutError };

/**
 * Minimal structural contract any workload orchestrator must expose to be
 * driven by {@link runContainerLifecycle}. The handle type is opaque —
 * platforms pass whatever shape identifies a running workload.
 */
export interface WorkloadOrchestrator<Handle> {
  startWorkload(handle: Handle): Promise<void>;
  stopWorkload(handle: Handle, timeoutSeconds?: number): Promise<void>;
  removeWorkload(handle: Handle): Promise<void>;
  waitForExit(handle: Handle): Promise<number>;
  streamLogs(handle: Handle, signal?: AbortSignal): AsyncIterable<string>;
}

export interface ContainerLifecycleOptions<Handle> {
  orchestrator: WorkloadOrchestrator<Handle>;
  handle: Handle;
  runId: string;
  /** Label surfaced in the "container started" progress event. */
  adapterName: string;
  /** Timeout in seconds. After expiry, the workload is stopped + RunTimeoutError is thrown. */
  timeout: number;
  /** Additional workload handles to stop on timeout (e.g. sidecar). */
  stopOnTimeout?: ReadonlyArray<Handle>;
  /** Arbitrary payload merged into the progress event's `data`. */
  extraData?: Record<string, unknown>;
  signal?: AbortSignal;
  /** Invoked with the raw orchestrator log stream; must yield structured run events. */
  processLogs: (logs: AsyncIterable<string>) => AsyncIterable<RunEvent>;
  /** Called when removeWorkload fails — platform-specific logging hook. */
  onRemoveError?: (handle: Handle, error: unknown) => void;
}

export async function* runContainerLifecycle<Handle>(
  options: ContainerLifecycleOptions<Handle>,
): AsyncGenerator<RunEvent> {
  const { orchestrator, handle, adapterName, runId, timeout, extraData, signal } = options;

  yield {
    type: "appstrate.progress",
    timestamp: Date.now(),
    runId,
    message: "container started",
    data: {
      adapter: adapterName,
      runId,
      workloadId: (handle as { id?: unknown }).id,
      ...extraData,
    },
  };

  await orchestrator.startWorkload(handle);

  const timeoutMs = timeout * 1000;
  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    orchestrator.stopWorkload(handle).catch(() => {});
    for (const h of options.stopOnTimeout ?? []) {
      orchestrator.stopWorkload(h).catch(() => {});
    }
  }, timeoutMs);

  let hasOutput = false;
  let lastError: string | undefined;

  try {
    for await (const event of options.processLogs(orchestrator.streamLogs(handle, signal))) {
      if (event.type === "output.emitted") hasOutput = true;
      if (event.type === "appstrate.error" && typeof event.message === "string") {
        lastError = event.message;
      }
      yield event;
    }

    if (signal?.aborted) {
      throw new RunCancelledError("Run cancelled", { runId, adapterName });
    }

    const exitCode = await orchestrator.waitForExit(handle);

    if (timedOut) {
      throw new RunTimeoutError(`Run timed out after ${timeout}s`);
    }

    if (exitCode !== 0 && !hasOutput) {
      throw new WorkloadExitError(adapterName, exitCode, lastError);
    }
  } finally {
    clearTimeout(timeoutHandle);
    await orchestrator.removeWorkload(handle).catch((err) => {
      options.onRemoveError?.(handle, err);
    });
  }
}
