// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Pi-extension wrapper for the platform runtime tools
 * (`output` / `log` / `note` / `pin` / `publish_file`).
 *
 * The tools' logic (input schema + validation + the canonical run events
 * each call produces) lives transport-neutrally in
 * `@appstrate/core/runtime-tool-defs` so the credential-isolating sidecar
 * can serve the SAME definitions as MCP tools without pulling the Pi SDK.
 * This wrapper is the second consumer: it registers each definition as a Pi
 * tool for the public `appstrate run` CLI, which has no sidecar to host the
 * MCP surface.
 *
 * Event delivery mirrors the MCP path: the tool handler returns its
 * canonical events under the `_meta` key; this wrapper re-emits them into
 * the run's event sink via {@link reEmitRuntimeToolEvents}. The default
 * emitter writes the stdout-JSONL line that `attachStdoutBridge` harvests --
 * the current wire contract, and the default precisely because it needs no
 * sink; callers that own one can pass an explicit `emit` to route events
 * directly.
 */

import { unsafeSchema, type ExtensionAPI, type ExtensionFactory } from "../pi-sdk.ts";
import {
  buildRuntimeToolDefs,
  buildOutputToolDef,
  buildPublishFileDef,
  reEmitRuntimeToolEvents,
  type FileUploader,
  type RuntimeToolDef,
  type RuntimeToolEvent,
} from "@appstrate/core/runtime-tool-defs";
import { piToolResultOrThrow } from "../pi-tool-result.ts";

export interface BuildRuntimeToolExtensionsOptions {
  /** Agent-selected runtime tools (`manifest.runtime_tools`). */
  runtimeTools?: readonly string[];
  /**
   * Sink for the canonical events each tool call produces. Defaults to the
   * stdout-JSONL emitter (`{...event, timestamp, runId}\n`) harvested by
   * `attachStdoutBridge`, so CLI callers need no extra wiring.
   */
  emit?: (event: RuntimeToolEvent) => void;
}

function defaultStdoutEmit(event: RuntimeToolEvent): void {
  const runId = process.env.AGENT_RUN_ID ?? "unknown";
  // `withEvents` already stamps a production-time `timestamp` on every event;
  // the spread order lets the event's own timestamp win, falling back to
  // emit-time only if one is somehow absent.
  process.stdout.write(JSON.stringify({ timestamp: Date.now(), runId, ...event }) + "\n");
}

/**
 * Build one Pi {@link ExtensionFactory} per selected runtime tool. Each
 * registers a Pi tool whose `execute` runs the shared core handler, re-emits
 * the resulting canonical events, and adapts the text result to Pi's shape
 * (a handler error — e.g. `output` failing its schema — throws as a Pi tool
 * error, so the terminal-tool early stop never fires on it).
 */
export function buildRuntimeToolExtensions(
  opts: BuildRuntimeToolExtensionsOptions,
): ExtensionFactory[] {
  const emit = opts.emit ?? defaultStdoutEmit;
  const defs = buildRuntimeToolDefs({
    ...(opts.runtimeTools !== undefined ? { runtimeTools: opts.runtimeTools } : {}),
  });
  return defs.map((def) => runtimeToolExtension(def, emit));
}

/** Register one {@link RuntimeToolDef} as a Pi extension. */
function runtimeToolExtension(
  def: RuntimeToolDef,
  emit: (event: RuntimeToolEvent) => void,
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: def.descriptor.name,
      label: def.descriptor.name,
      description: def.descriptor.description,
      parameters: unsafeSchema<Record<string, unknown>>(def.descriptor.inputSchema),
      async execute(_toolCallId, params) {
        const result = await def.handler(params ?? {});
        reEmitRuntimeToolEvents(result._meta, emit);
        return piToolResultOrThrow({
          content: result.content.map((c) => ({ type: "text" as const, text: c.text })),
          isError: result.isError === true,
        });
      },
    });
  };
}

export interface BuildPublishFileExtensionOptions {
  /** Uploads a workspace file to the platform, returning its file metadata. */
  uploader: FileUploader;
  /** Sink for the `file.published` event the tool emits (defaults to stdout-JSONL). */
  emit?: (event: RuntimeToolEvent) => void;
}

/**
 * Build the `publish_file` Pi extension around an injected uploader. The
 * uploader (holding the run's HMAC sink signer) is wired in the runtime
 * entrypoint, so this tool is registered in-process even when the sidecar
 * hosts the other runtime tools over MCP — the sidecar has no path back to the
 * platform files route.
 */
export function buildPublishFileExtension(
  opts: BuildPublishFileExtensionOptions,
): ExtensionFactory {
  const emit = opts.emit ?? defaultStdoutEmit;
  return runtimeToolExtension(buildPublishFileDef(opts.uploader), emit);
}

/**
 * Build the `output` Pi extension for an agent that declares `outputSchema`.
 * {@link PiRunner} registers it itself from its `outputSchema` option, with
 * `emit` writing into the run's event sink.
 */
export function buildOutputExtension(
  outputSchema: Record<string, unknown>,
  emit: (event: RuntimeToolEvent) => void,
): ExtensionFactory {
  return runtimeToolExtension(buildOutputToolDef(outputSchema), emit);
}
