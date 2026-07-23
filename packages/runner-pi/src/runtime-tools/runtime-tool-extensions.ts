// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Pi-extension wrapper for the platform runtime tools
 * (`output` / `log` / `note` / `pin` / `report`).
 *
 * The tools' logic (input schema + validation + the canonical run events
 * each call produces) lives transport-neutrally in
 * `@appstrate/core/runtime-tool-defs` so the credential-isolating sidecar
 * can serve the SAME definitions as MCP tools without pulling the Pi SDK.
 * This wrapper is the second consumer: it registers each definition as a Pi
 * tool for the **no-sidecar execution path** — the platform skip-sidecar
 * branch (`runtime-pi/entrypoint.ts`) and the public `appstrate run` CLI,
 * neither of which has a sidecar to host the MCP surface.
 *
 * Event delivery mirrors the MCP path: the tool handler returns its
 * canonical events under the `_meta` key; this wrapper re-emits them into
 * the run's event sink via {@link reEmitRuntimeToolEvents}. The default
 * emitter writes the legacy stdout-JSONL line so the existing
 * `attachStdoutBridge` harvesting keeps working unchanged; callers that own
 * a sink can pass an explicit `emit` to route events directly.
 */

import { Type, type ExtensionAPI, type ExtensionFactory } from "../pi-sdk.ts";
import {
  buildRuntimeToolDefs,
  buildPublishDocumentDef,
  reEmitRuntimeToolEvents,
  type DocumentUploader,
  type RuntimeToolDef,
  type RuntimeToolEvent,
} from "@appstrate/core/runtime-tool-defs";

export interface BuildRuntimeToolExtensionsOptions {
  /** Agent-selected runtime tools (`manifest.runtime_tools`). */
  runtimeTools?: readonly string[];
  /** Output JSON Schema (constrains + validates `output`'s `data` arg). */
  outputSchema?: Record<string, unknown> | null;
  /**
   * Sink for the canonical events each tool call produces. Defaults to the
   * legacy stdout-JSONL emitter (`{...event, timestamp, runId}\n`) harvested
   * by `attachStdoutBridge` — same wire contract the former built-in tools
   * used, so no-sidecar callers need no extra wiring.
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
 * the resulting canonical events, and adapts the text result to Pi's shape.
 */
export function buildRuntimeToolExtensions(
  opts: BuildRuntimeToolExtensionsOptions,
): ExtensionFactory[] {
  const emit = opts.emit ?? defaultStdoutEmit;
  const defs = buildRuntimeToolDefs({
    ...(opts.runtimeTools !== undefined ? { runtimeTools: opts.runtimeTools } : {}),
    ...(opts.outputSchema !== undefined ? { outputSchema: opts.outputSchema } : {}),
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
      parameters: Type.Unsafe<Record<string, unknown>>(def.descriptor.inputSchema),
      async execute(_toolCallId, params) {
        const result = await def.handler(params ?? {});
        reEmitRuntimeToolEvents(result._meta, emit);
        return {
          content: result.content.map((c) => ({ type: "text" as const, text: c.text })),
          details: undefined,
          ...(result.isError ? { isError: true } : {}),
        };
      },
    });
  };
}

export interface BuildPublishDocumentExtensionOptions {
  /** Uploads a workspace file to the platform, returning its document metadata. */
  uploader: DocumentUploader;
  /** Sink for the `document.published` event the tool emits (defaults to stdout-JSONL). */
  emit?: (event: RuntimeToolEvent) => void;
}

/**
 * Build the `publish_document` Pi extension around an injected uploader. The
 * uploader (holding the run's HMAC sink signer) is wired in the runtime
 * entrypoint, so this tool is registered in-process even when the sidecar
 * hosts the other runtime tools over MCP — the sidecar has no path back to the
 * platform documents route.
 */
export function buildPublishDocumentExtension(
  opts: BuildPublishDocumentExtensionOptions,
): ExtensionFactory {
  const emit = opts.emit ?? defaultStdoutEmit;
  return runtimeToolExtension(buildPublishDocumentDef(opts.uploader), emit);
}
