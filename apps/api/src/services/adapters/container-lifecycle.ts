import { logger } from "../../lib/logger.ts";
import type { ExecutionMessage } from "./types.ts";
import { TimeoutError } from "./types.ts";
import {
  startContainer,
  streamLogs,
  waitForExit,
  stopContainer,
  removeContainer,
} from "../docker.ts";

export interface ContainerLifecycleOptions {
  containerId: string;
  adapterName: string;
  executionId: string;
  timeout: number;
  extraData?: Record<string, unknown>;
  signal?: AbortSignal;
  /** Extra container IDs to stop on timeout (e.g. sidecar). */
  stopOnTimeout?: string[];
  processLogs: (logs: AsyncGenerator<string>) => AsyncGenerator<ExecutionMessage>;
}

/**
 * Shared container lifecycle: start, timeout, stream loop, exit handling, and cleanup.
 * File injection must be done before calling this (for parallelization with sidecar startup).
 */
export async function* runContainerLifecycle(
  options: ContainerLifecycleOptions,
): AsyncGenerator<ExecutionMessage> {
  const { containerId, adapterName, executionId, timeout, extraData, signal } = options;

  yield {
    type: "progress",
    message: `${adapterName} container started`,
    data: { adapter: adapterName, executionId, containerId, ...extraData },
  };

  await startContainer(containerId);

  // Timeout: stop the container if it exceeds the limit
  const timeoutMs = timeout * 1000;
  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    stopContainer(containerId).catch(() => {});
    for (const id of options.stopOnTimeout ?? []) {
      stopContainer(id).catch(() => {});
    }
  }, timeoutMs);

  let hasResult = false;

  try {
    for await (const msg of options.processLogs(streamLogs(containerId, signal))) {
      if (msg.type === "result") hasResult = true;
      yield msg;
    }

    // Skip waitForExit if cancelled — container will be killed by stopContainer
    if (signal?.aborted) {
      throw new Error("Execution cancelled");
    }

    const exitCode = await waitForExit(containerId);

    if (timedOut) {
      throw new TimeoutError(`Execution timed out after ${timeout}s`);
    }

    if (exitCode !== 0 && !hasResult) {
      throw new Error(`${adapterName} container exited with code ${exitCode}`);
    }
  } finally {
    clearTimeout(timeoutHandle);
    await removeContainer(containerId).catch((err) => {
      logger.error("Failed to remove container", {
        containerId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}
