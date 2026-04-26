// SPDX-License-Identifier: Apache-2.0

/**
 * Single-shot "runtime ready" signal emitted by any Pi-based runner
 * (runtime-pi container entrypoint, CLI `apps/cli/src/commands/run.ts`,
 * GitHub Action) after the bundle is loaded and providers are wired,
 * but before `PiRunner.run()` starts.
 *
 * Purpose: give the user (dashboard or terminal) a first log line
 * immediately on cold starts (Docker pull + workspace init + dynamic
 * tool imports can take seconds) instead of a silent gap between
 * `status=pending` and the first tool call. Routed through the
 * unified event pipeline so it lands in `run_logs` the same way every
 * other canonical event does.
 *
 * Emitted as `appstrate.progress` — not `run.started` — so the webhook
 * event-type catalogue, OpenAPI spec, and downstream `onRunStatusChange`
 * consumers stay unchanged. The platform's `lastEventSequence === 0`
 * check flips `pending → running` on *any* first event, so this progress
 * line doubles as the liveness transition for platform-origin runs
 * without any type-specific server logic.
 *
 * Lives in `@appstrate/runner-pi` (not `runtime-pi/`) so both the
 * in-container bootloader and external Pi-based runners (CLI, GitHub
 * Action) share the exact same signal shape.
 */

import type { EventSink } from "@appstrate/afps-runtime/interfaces";

export interface RuntimeReadyPayload {
  /** True when a concrete `.afps`/`.afps-bundle` was loaded from disk. */
  bundleLoaded: boolean;
  /** Count of extension factories (bundle tools + runtime-shipped extensions + provider tools). */
  extensions: number;
  /** Caller-computed elapsed ms since its own "boot start" (process entry for runtime-pi, command entry for the CLI). */
  bootDurationMs: number;
  /**
   * Runtime ↔ platform wire protocol version. MAJOR.MINOR — runners on
   * `2.0` advertise MCP-native tool surfaces (`provider_call`,
   * `run_history`, `recall_memory`) and resource URIs. Old consumers
   * that don't read the field are unaffected (additive on the event
   * envelope).
   */
  runtimeProtocolVersion?: string;
}

/**
 * Current runtime ↔ platform protocol version. `2.0` marks the
 * MCP-native tool surface — there is no `1.x` interop on this branch.
 */
export const CURRENT_RUNTIME_PROTOCOL_VERSION = "2.0" as const;

/**
 * Emit the "runtime ready" progress event. Awaits the sink's POST —
 * the caller runs this just once and the few-ms round-trip is
 * acceptable. Failures propagate to the caller so the bootstrap error
 * path can escalate as needed.
 */
export async function emitRuntimeReady(
  sink: EventSink,
  runId: string,
  payload: RuntimeReadyPayload,
  now: () => number = Date.now,
): Promise<void> {
  const protocolVersion = payload.runtimeProtocolVersion ?? CURRENT_RUNTIME_PROTOCOL_VERSION;
  await sink.handle({
    type: "appstrate.progress",
    timestamp: now(),
    runId,
    message: `runtime ready in ${Math.round(payload.bootDurationMs)}ms`,
    data: {
      bundleLoaded: payload.bundleLoaded,
      extensions: payload.extensions,
      runtimeProtocolVersion: protocolVersion,
    },
    level: "info",
  });
}
