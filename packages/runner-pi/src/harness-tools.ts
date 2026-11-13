// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Harness tools — the two tools {@link PiRunner} itself offers the model, as
 * Pi extensions: `output` ({@link buildOutputExtension}), registered when the
 * agent declares an `output.schema`, and `publish_file`
 * ({@link buildPublishFileExtension}), registered around an injected HTTP
 * uploader.
 *
 * Event delivery: the runner passes each extension an `emit` function that
 * stamps the event's `runId` and `timestamp` and writes it to the run's event
 * sink; a successful call awaits it before returning, so the event is settled
 * before the run can finalize. A refused call throws (Pi's tool-error signal,
 * see `pi-tool-result.ts`) and emits nothing, so the terminal-tool early stop
 * never fires on it.
 */

import { asJSONSchemaObject } from "@appstrate/core/form";
import { compileCached } from "@appstrate/core/schema-validation";
import type { RunAndWaitFile } from "@appstrate/core/run-and-wait-client";
import { unsafeSchema, type ExtensionAPI, type ExtensionFactory } from "./pi-sdk.ts";
import type { PiToolResult } from "./pi-tool-result.ts";

/** Name of the `output` tool, the run's terminal tool. */
export const OUTPUT_TOOL_NAME = "output";

/**
 * A canonical run event produced by a harness tool call: `output.emitted`
 * (`output`) or `file.published` (`publish_file`).
 */
export interface HarnessToolEvent {
  type: "output.emitted" | "file.published";
  [k: string]: unknown;
}

type Emit = (event: HarnessToolEvent) => Promise<void>;

interface HarnessTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Returns the event to emit and the reply text; throws to refuse the call. */
  call: (args: Record<string, unknown>) => Promise<{ event: HarnessToolEvent; reply: string }>;
}

function harnessToolExtension(tool: HarnessTool, emit: Emit): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: unsafeSchema<Record<string, unknown>>(tool.inputSchema),
      async execute(_toolCallId, params): Promise<PiToolResult> {
        const { event, reply } = await tool.call((params ?? {}) as Record<string, unknown>);
        await emit(event);
        return { content: [{ type: "text", text: reply }], details: undefined };
      },
    });
  };
}

/**
 * Build the `output` Pi extension for an agent that declares `outputSchema`:
 * the schema becomes the `data` argument schema (the model sees it in the tool
 * definition), every call is validated against it, and a valid call emits the
 * `output.emitted` run event. The agent must call it exactly once.
 */
export function buildOutputExtension(
  outputSchema: Record<string, unknown>,
  emit: Emit,
): ExtensionFactory {
  // Compiled through the ONE shared Ajv2020 instance and its cache
  // (`@appstrate/core/schema-validation`), the instance the server's
  // `validateOutput` uses on the same `output.schema`: both sides of the
  // container boundary give the same verdict (2020-12 keywords, formats).
  //
  // A schema that cannot compile refuses every call: the server's
  // `compileCached` throws on it too, so refusing here changes the failure's
  // timing and legibility, not the run's outcome.
  let validator: ReturnType<typeof compileCached> | null = null;
  let schemaCompileError: string | null = null;
  try {
    validator = compileCached(asJSONSchemaObject(outputSchema));
  } catch (err) {
    schemaCompileError = err instanceof Error ? err.message : String(err);
  }
  const dataSchema: Record<string, unknown> = {
    ...outputSchema,
    description:
      typeof outputSchema.description === "string"
        ? outputSchema.description
        : "JSON object to return as the run output",
  };
  return harnessToolExtension(
    {
      name: OUTPUT_TOOL_NAME,
      description:
        "Call exactly once, as your final action, with the complete output object that " +
        "satisfies the declared schema (all required fields must be provided). A successful " +
        "call ends the run immediately — do all other work first.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["data"],
        properties: { data: dataSchema },
      },
      call: async ({ data }) => {
        if (schemaCompileError) {
          throw new Error(
            `This agent's declared output schema cannot be compiled: ${schemaCompileError}\n\n` +
              "No output can be recorded until the manifest's `output.schema` is a valid " +
              "JSON Schema 2020-12 document. This is not something the run can work around.",
          );
        }
        if (validator && !validator(data)) {
          const errors = (validator.errors ?? [])
            .map((e) => `  - ${e.instancePath || "/"} ${e.message}`)
            .join("\n");
          throw new Error(
            `Output validation failed:\n${errors}\n\n` +
              `Please call output() again with all required fields correctly typed.`,
          );
        }
        return {
          event: { type: "output.emitted", data: data as Record<string, unknown> },
          reply: "Output recorded",
        };
      },
    },
    emit,
  );
}

/**
 * Durable file metadata returned by a successful upload. Extends the
 * {@link RunAndWaitFile} projection (`{ id, uri, name, mime, size }` — the
 * shape the run_and_wait tool result embeds) with upload integrity.
 */
export interface PublishedFile extends RunAndWaitFile {
  sha256: string;
}

/** The canonical `file.published` run event for a stored file. */
interface FilePublishedEvent extends HarnessToolEvent {
  type: "file.published";
  fileId: string;
  uri: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
}

/**
 * Build the canonical `file.published` run event from an uploaded file's
 * metadata. Single builder shared by every producer — the `publish_file` tool
 * ({@link buildPublishFileExtension}) and the runtime's end-of-run `outputs/`
 * sweep — so the event's field set is defined once.
 */
export function filePublishedEvent(file: PublishedFile): FilePublishedEvent {
  return {
    type: "file.published",
    fileId: file.id,
    uri: file.uri,
    name: file.name,
    mime: file.mime,
    size: file.size,
    sha256: file.sha256,
  };
}

/**
 * Uploads a workspace file to the platform and returns its durable file
 * metadata. Injected into {@link buildPublishFileExtension} by the host (which
 * holds the run's HMAC sink signer).
 */
export type FileUploader = (path: string, name?: string) => Promise<PublishedFile>;

/**
 * Build the `publish_file` Pi extension around an injected
 * {@link FileUploader}: the call performs the upload, then emits the canonical
 * `file.published` event so ingestion persists a run_log. An upload failure
 * (cap / quota / HTTP) refuses the call with a clear message the agent can
 * react to.
 */
export function buildPublishFileExtension(uploader: FileUploader, emit: Emit): ExtensionFactory {
  return harnessToolExtension(
    {
      name: "publish_file",
      description:
        "Publish a workspace file (an HTML report, a CSV, a PDF, an image, source code — " +
        "anything on disk) as a durable file attached to this run, right now: the file appears " +
        "while the run is still going and the call returns its stable `appfile://` URI. Use it " +
        "whenever you need to reference, " +
        "link or send the file within this same run — cite the URI in your output, hand it to " +
        "another tool — or to see an upload failure in time to react. Files written under " +
        "`./outputs/` are published automatically at the end of the run, which is enough for a " +
        "plain end-of-run deliverable, but that happens after you are done: you never get their " +
        "URIs.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: {
          path: {
            type: "string",
            description: "Path to the file to publish, relative to the workspace root.",
          },
          name: {
            type: "string",
            description: "Optional display name for the file (defaults to the file name on disk).",
          },
        },
      },
      // Only the declared arguments are read; any other key is ignored.
      call: async ({ path, name }) => {
        if (typeof path !== "string" || path.length === 0) {
          throw new Error("publish_file requires a non-empty `path`.");
        }
        let file: PublishedFile;
        try {
          file = await uploader(
            path,
            typeof name === "string" && name.length > 0 ? name : undefined,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(`Failed to publish '${path}': ${message}`, { cause: err });
        }
        return { event: filePublishedEvent(file), reply: `Published ${file.name} → ${file.uri}` };
      },
    },
    emit,
  );
}
