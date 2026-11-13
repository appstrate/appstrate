// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Runtime tool definitions — the two tools the runner itself offers the
 * model, expressed as transport-neutral, Pi-agnostic tool definitions:
 * `output`, built by {@link buildOutputToolDef} when the agent declares an
 * `output.schema`, and `publish_file`, built by {@link buildPublishFileDef}
 * around an injected HTTP uploader. `@appstrate/runner-pi` registers both as
 * Pi extensions (see `outputSchema` and `fileUploader` on its `PiRunner`).
 *
 * Event delivery: the runner passes each handler the `emit` function of the
 * run's single event sink; a successful call emits its canonical run event
 * through it, stamped with a production-time `timestamp`, before returning.
 *
 * Lives in `@appstrate/core` (dependency-light, already ships `ajv`) so the
 * tool logic carries no Pi SDK dependency.
 */

import type { ValidateFunction } from "ajv";
import { asJSONSchemaObject } from "./form.ts";
import { compileCached } from "./schema-validation.ts";
import type { RunAndWaitFile } from "./run-and-wait-client.ts";

/**
 * A canonical run event produced by a runtime tool call: `output.emitted`
 * (`output`) or `file.published` (`publish_file`).
 */
export interface RuntimeToolEvent {
  type: "output.emitted" | "file.published";
  [k: string]: unknown;
}

/** The (text-only) result shape every runtime tool returns. */
export interface RuntimeToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/**
 * Transport-neutral runtime tool definition. Structurally compatible with
 * `@appstrate/mcp-transport`'s `AppstrateToolDefinition` without coupling
 * core to the transport package.
 */
export interface RuntimeToolDef {
  descriptor: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  };
  /** `emit` writes into the run's event sink. */
  handler: (
    rawArgs: unknown,
    emit: (event: RuntimeToolEvent) => void,
  ) => Promise<RuntimeToolResult>;
}

function emitAndReply(
  emit: (event: RuntimeToolEvent) => void,
  event: RuntimeToolEvent,
  text: string,
): RuntimeToolResult {
  // Canonical run events carry a required `timestamp` and the run sink does
  // not stamp one: stamp it here, at the single emit point of both tools.
  emit({ timestamp: Date.now(), ...event });
  return { content: [{ type: "text", text }] };
}

function toolError(text: string): RuntimeToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * Build the `output` tool for an agent that declares `outputSchema`: the
 * schema becomes the `data` argument schema (the model sees it in the tool
 * definition), every call is validated against it, and a valid call produces
 * the `output.emitted` run event. The agent must call it exactly once.
 */
export function buildOutputToolDef(outputSchema: Record<string, unknown>): RuntimeToolDef {
  // Compile through the ONE shared Ajv2020 instance and its cache
  // (`@appstrate/core/schema-validation`), not a private second instance.
  //
  // This used to be `new Ajv(...)` — the draft-07 default export, with no
  // ajv-formats. The server validates the SAME `output.schema` on the 2020-12
  // dialect with formats (`validateOutput` → `compileCached`), so a schema
  // using `prefixItems`, `$dynamicRef` or `format` got two different verdicts
  // on the two sides of the container boundary. That is the exact drift this
  // in-container check exists to prevent.
  //
  // A private instance was doubly wrong: it never called `removeSchema`, so it
  // retained every compiled schema AND threw "schema with key or id … already
  // exists" the second time a schema carrying `$id` was compiled in the same
  // process — which the `catch` below then swallowed into `validator = null`.
  //
  // A compile failure is now RECORDED, not swallowed. `if (validator && …)`
  // meant an uncompilable schema silently accepted every payload: the agent saw
  // a clean success and the run failed later, server-side, at the post-hoc
  // check this tool exists to pre-empt. The server's `compileCached` throws on
  // such a schema, so refusing here changes the failure's timing and legibility,
  // not the run's outcome.
  let validator: ValidateFunction | null = null;
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
  const description =
    "Call exactly once, as your final action, with the complete output object that " +
    "satisfies the declared schema (all required fields must be provided). A successful " +
    "call ends the run immediately — do all other work first.";
  return {
    descriptor: {
      name: "output",
      description,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["data"],
        properties: { data: dataSchema },
      },
    },
    handler: async (rawArgs, emit) => {
      const { data } = (rawArgs ?? {}) as { data?: Record<string, unknown> };
      if (schemaCompileError) {
        return toolError(
          `This agent's declared output schema cannot be compiled: ${schemaCompileError}\n\n` +
            "No output can be recorded until the manifest's `output.schema` is a valid " +
            "JSON Schema 2020-12 document. This is not something the run can work around.",
        );
      }
      if (validator && !validator(data)) {
        const errors = (validator.errors ?? [])
          .map((e) => `  - ${e.instancePath || "/"} ${e.message}`)
          .join("\n");
        return toolError(
          `Output validation failed:\n${errors}\n\n` +
            `Please call output() again with all required fields correctly typed.`,
        );
      }
      return emitAndReply(
        emit,
        { type: "output.emitted", data: data as Record<string, unknown> },
        "Output recorded",
      );
    },
  };
}

// ---------------------------------------------------------------------------
// publish_file — the one runtime tool with a side effect (HTTP upload)
// ---------------------------------------------------------------------------

/**
 * Durable file metadata returned by a successful upload. Extends the
 * {@link RunAndWaitFile} projection (`{ id, uri, name, mime, size }` — the
 * shape the run_and_wait tool result embeds) with upload integrity.
 */
export interface PublishedFile extends RunAndWaitFile {
  sha256: string;
}

/** The canonical `file.published` run event for a stored file. */
export interface FilePublishedEvent extends RuntimeToolEvent {
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
 * metadata. Single builder shared by every producer — the `publish_file`
 * runtime tool ({@link buildPublishFileDef}) and the runtime's end-of-run
 * `outputs/` sweep — so the event's field set is defined once and cannot drift
 * between the two call sites.
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
 * metadata. Injected into {@link buildPublishFileDef} by the runtime
 * entrypoint (which holds the run's HMAC sink signer).
 */
export type FileUploader = (path: string, name?: string) => Promise<PublishedFile>;

/**
 * Build the `publish_file` runtime tool def around an injected
 * {@link FileUploader}. Unlike `output` this tool performs the upload
 * itself (via `uploader`), then emits the canonical
 * `file.published` event so ingestion persists a run_log.
 * An upload failure (cap / quota / HTTP) is returned as a tool error, never a
 * throw — the agent sees a clear message and can continue.
 */
export function buildPublishFileDef(uploader: FileUploader): RuntimeToolDef {
  return {
    descriptor: {
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
    },
    handler: async (rawArgs, emit) => {
      // Only the declared arguments are read. `additionalProperties: false`
      // already keeps a schema-validating caller from sending anything else;
      // for a caller that skips validation, an extra key (notably the retired
      // `presentation`) is silently ignored rather than rejected — the tool has
      // no notion of presentation any more, and refusing the call would lose a
      // real deliverable over a dead argument.
      const { path, name } = (rawArgs ?? {}) as {
        path?: unknown;
        name?: unknown;
      };
      if (typeof path !== "string" || path.length === 0) {
        return toolError("publish_file requires a non-empty `path`.");
      }
      let file: PublishedFile;
      try {
        file = await uploader(path, typeof name === "string" && name.length > 0 ? name : undefined);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return toolError(`Failed to publish '${path}': ${message}`);
      }
      return emitAndReply(emit, filePublishedEvent(file), `Published ${file.name} → ${file.uri}`);
    },
  };
}
