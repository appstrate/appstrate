import type { ExecutionAdapter, ExecutionMessage } from "./types.ts";
import {
  createContainer,
  startContainer,
  streamLogs,
  waitForExit,
  removeContainer,
  stopContainer,
} from "../docker.ts";

export class DockerAdapter implements ExecutionAdapter {
  async *execute(
    executionId: string,
    envVars: Record<string, string>,
    _flowPath: string,
    timeout: number,
  ): AsyncGenerator<ExecutionMessage> {
    const containerId = await createContainer(executionId, envVars, _flowPath);

    yield { type: "progress", message: `Container started`, data: { containerId, adapter: "docker" } };

    await startContainer(containerId);

    const timeoutMs = timeout * 1000;
    let timedOut = false;

    const timeoutHandle = setTimeout(async () => {
      timedOut = true;
      try {
        await stopContainer(containerId, 5);
      } catch {}
    }, timeoutMs);

    try {
      for await (const line of streamLogs(containerId)) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === "progress") {
            yield { type: "progress", message: parsed.message };
          } else if (parsed.type === "result") {
            yield { type: "result", data: parsed.data };
          }
        } catch {
          if (line.trim()) {
            yield { type: "progress", message: line.trim() };
          }
        }
      }
    } finally {
      clearTimeout(timeoutHandle);
    }

    await waitForExit(containerId);

    if (timedOut) {
      throw new TimeoutError(`Execution timed out after ${timeout}s`);
    }

    // Cleanup container
    try {
      await removeContainer(containerId);
    } catch {}
  }
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}
