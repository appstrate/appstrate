// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Pi-extension wrapper for the runtime tools the runner itself offers the
 * model (`output` / `publish_file`).
 *
 * The tools' logic (input schema + validation + the canonical run events
 * each call produces) lives transport-neutrally in
 * `@appstrate/core/runtime-tool-defs`. This wrapper registers each definition
 * as a Pi tool and hands its handler the run's `emit`.
 * A handler error (e.g. `output` failing its schema) throws as a Pi tool
 * error, so the terminal-tool early stop never fires on it.
 */

import { unsafeSchema, type ExtensionAPI, type ExtensionFactory } from "../pi-sdk.ts";
import {
  buildOutputToolDef,
  buildPublishFileDef,
  type FileUploader,
  type RuntimeToolDef,
  type RuntimeToolEvent,
} from "@appstrate/core/runtime-tool-defs";
import { piToolResultOrThrow } from "../pi-tool-result.ts";

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
        const result = await def.handler(params ?? {}, emit);
        return piToolResultOrThrow({
          content: result.content.map((c) => ({ type: "text" as const, text: c.text })),
          isError: result.isError === true,
        });
      },
    });
  };
}

/**
 * Build the `publish_file` Pi extension around an injected uploader (holding
 * the run's HMAC sink signer). {@link PiRunner} registers it itself from its
 * `fileUploader` option, with `emit` writing into the run's event sink.
 */
export function buildPublishFileExtension(
  uploader: FileUploader,
  emit: (event: RuntimeToolEvent) => void,
): ExtensionFactory {
  return runtimeToolExtension(buildPublishFileDef(uploader), emit);
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
