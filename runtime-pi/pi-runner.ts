// SPDX-License-Identifier: Apache-2.0

import { PiRunner, type PiRunnerOptions } from "@appstrate/runner-pi";

type RuntimePiRunnerOptions = Omit<PiRunnerOptions, "transport"> & {
  /**
   * Captured sidecar topology. Required so runtime callers cannot silently
   * omit the transport decision; `undefined` preserves Pi's direct-run default.
   */
  sidecarUrl: string | undefined;
};

/**
 * Build the runtime's Pi runner. The sidecar `/llm` route is HTTP/SSE-only;
 * Pi's `"auto"` would first probe it with a WebSocket GET (405).
 */
export function createRuntimePiRunner({
  sidecarUrl,
  ...options
}: RuntimePiRunnerOptions): PiRunner {
  return new PiRunner({
    ...options,
    ...(sidecarUrl ? { transport: "sse" } : {}),
  });
}
