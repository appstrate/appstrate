// SPDX-License-Identifier: Apache-2.0

import { logger } from "../../lib/logger.ts";
import type { ExecutionMessage } from "./types.ts";
import { TimeoutError } from "./types.ts";
import type { ContainerOrchestrator, WorkloadHandle } from "../orchestrator/index.ts";

export interface ContainerLifecycleOptions {
  orchestrator: ContainerOrchestrator;
  handle: WorkloadHandle;
  adapterName: string;
  runId: string;
  timeout: number;
  extraData?: Record<string, unknown>;
  signal?: AbortSignal;
  /** Extra workload handles to stop on timeout (e.g. sidecar). */
  stopOnTimeout?: WorkloadHandle[];
  processLogs: (logs: AsyncGenerator<string>) => AsyncGenerator<ExecutionMessage>;
}

/**
 * Shared workload lifecycle: start, timeout, stream loop, exit handling, and cleanup.
 * File injection must be done before calling this (for parallelization with sidecar startup).
 */
export async function* runContainerLifecycle(
  options: ContainerLifecycleOptions,
): AsyncGenerator<ExecutionMessage> {
  const { orchestrator, handle, adapterName, runId, timeout, extraData, signal } = options;

  yield {
    type: "progress",
    message: `container started`,
    data: { adapter: adapterName, runId, workloadId: handle.id, ...extraData },
  };

  await orchestrator.startWorkload(handle);

  // Timeout: stop the workload if it exceeds the limit
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
    for await (const msg of options.processLogs(orchestrator.streamLogs(handle, signal))) {
      if (msg.type === "output") hasOutput = true;
      if (msg.type === "error") lastError = msg.message;
      yield msg;
    }

    // Skip waitForExit if cancelled — workload will be killed by stopWorkload
    if (signal?.aborted) {
      throw new Error("Execution cancelled");
    }

    const exitCode = await orchestrator.waitForExit(handle);

    if (timedOut) {
      throw new TimeoutError(`Execution timed out after ${timeout}s`);
    }

    if (exitCode !== 0 && !hasOutput) {
      throw new Error(lastError ?? `${adapterName} workload exited with code ${exitCode}`);
    }
  } finally {
    clearTimeout(timeoutHandle);
    await orchestrator.removeWorkload(handle).catch((err) => {
      logger.error("Failed to remove workload", {
        workloadId: handle.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}
