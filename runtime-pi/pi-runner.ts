// SPDX-License-Identifier: Apache-2.0

import { PiRunner, type PiRunnerOptions } from "@appstrate/runner-pi";

/**
 * Build the runtime's Pi runner. Inference rides the sidecar's `/llm` route,
 * which is HTTP/SSE-only; Pi's `"auto"` would first probe it with a WebSocket
 * GET (405).
 */
export function createRuntimePiRunner(options: Omit<PiRunnerOptions, "transport">): PiRunner {
  return new PiRunner({ ...options, transport: "sse" });
}
