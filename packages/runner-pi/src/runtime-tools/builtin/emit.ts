// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Shared stdout CloudEvent emitter for the built-in runtime tools
 * (log / note / pin / report / output). Each call writes one JSON line
 * stamped with the run id + timestamp, harvested by the agent entrypoint
 * into the run's progress stream.
 */

const RUN_ID = process.env.AGENT_RUN_ID ?? "unknown";

export function emit(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ ...obj, timestamp: Date.now(), runId: RUN_ID }) + "\n");
}
