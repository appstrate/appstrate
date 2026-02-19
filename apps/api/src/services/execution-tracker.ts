// Tracks in-flight executions for graceful shutdown and cancellation.

const inFlight = new Map<string, AbortController>();

export function trackExecution(executionId: string): AbortController {
  const controller = new AbortController();
  inFlight.set(executionId, controller);
  return controller;
}

export function untrackExecution(executionId: string): void {
  inFlight.delete(executionId);
}

export function abortExecution(executionId: string): void {
  const controller = inFlight.get(executionId);
  if (controller) controller.abort();
}

export function getInFlightCount(): number {
  return inFlight.size;
}

/** Wait for all in-flight executions to complete, up to timeoutMs. Returns true if all drained. */
export async function waitForInFlight(timeoutMs: number): Promise<boolean> {
  if (inFlight.size === 0) return true;

  const deadline = Date.now() + timeoutMs;
  const pollInterval = 500;

  while (inFlight.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  return inFlight.size === 0;
}
