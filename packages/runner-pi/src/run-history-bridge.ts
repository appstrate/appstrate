// SPDX-License-Identifier: Apache-2.0

/**
 * Bridge the AFPS {@link makeRunHistoryTool} to the Pi SDK's extension
 * system so the agent sees `run_history` as a regular Pi tool.
 *
 * Used by any caller that assembles a {@link PiRunner} alongside a
 * sidecar — currently the `runtime-pi` container entrypoint. The CLI
 * does not wire this today (no sidecar); when it does, a
 * `createLocalRunHistoryCall` factory can be plugged in without
 * touching this bridge.
 */

import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import {
  createSidecarRunHistoryCall,
  makeRunHistoryTool,
  type CreateSidecarRunHistoryCallOptions,
} from "@appstrate/afps-runtime/resolvers";
import type { RunEvent } from "@appstrate/afps-runtime/resolvers";
import { afpsToolToPiExtension, type ProviderEventEmitter } from "./provider-bridge.ts";

export interface BuildRunHistoryExtensionFactoryOptions {
  /** Sidecar base URL (typically `http://sidecar:8080`). */
  sidecarUrl: string;
  /** Stable run identifier propagated into the tool context. */
  runId: string;
  /** Workspace directory propagated into the tool context. */
  workspace: string;
  /** Receives `run_history.called` events. */
  emit: (event: RunEvent) => void;
  /**
   * Transport overrides forwarded to {@link createSidecarRunHistoryCall}
   * (custom `fetch`, `baseHeaders`, `timeoutMs`). `sidecarUrl` is taken
   * from the top-level option to keep the primary wiring site simple.
   */
  transport?: Omit<CreateSidecarRunHistoryCallOptions, "sidecarUrl">;
}

/**
 * Produce a single {@link ExtensionFactory} that registers `run_history`
 * against the supplied sidecar. Fails fast (throws) if `sidecarUrl` is
 * missing — callers should not attempt to wire the tool without a
 * configured transport.
 */
export function buildRunHistoryExtensionFactory(
  opts: BuildRunHistoryExtensionFactoryOptions,
): ExtensionFactory {
  const call = createSidecarRunHistoryCall({
    sidecarUrl: opts.sidecarUrl,
    ...(opts.transport ?? {}),
  });
  const tool = makeRunHistoryTool(call);
  const emit: ProviderEventEmitter = (event) => opts.emit(event as RunEvent);
  return afpsToolToPiExtension(tool, opts.runId, opts.workspace, emit);
}
