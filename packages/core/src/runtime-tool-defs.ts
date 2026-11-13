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
 * Event delivery: a tool call NEVER emits directly. It returns the
 * canonical run events under the result `_meta` key
 * {@link RUNTIME_TOOL_EVENTS_META_KEY}; the runner re-emits them into the
 * run's single event sink through {@link reEmitRuntimeToolEvents}, which keeps
 * a single sequence source for the run-event pipeline.
 *
 * Lives in `@appstrate/core` (dependency-light, already ships `ajv`) so the
 * tool logic carries no Pi SDK dependency.
 */

import type { ValidateFunction } from "ajv";
import { asJSONSchemaObject } from "./form.ts";
import { compileCached } from "./schema-validation.ts";
import type { RunAndWaitFile } from "./run-and-wait-client.ts";

/**
 * `_meta` key under which a runtime tool call surfaces the canonical run
 * events it produced (`output.emitted`, `file.published`). The runner reads
 * this key and re-emits each event into the run's event sink.
 *
 * AFPS (Phase F1): reverse-DNS namespace — `_meta` keys must be
 * either a single bare token or a reverse-DNS prefix (RFC §2.2 / Appendix
 * B). The canonical form is `"dev.appstrate/events"`.
 */
export const RUNTIME_TOOL_EVENTS_META_KEY = "dev.appstrate/events";

/**
 * The closed set of canonical run-event types a runtime tool may emit. Used
 * as a trust-boundary allowlist by {@link reEmitRuntimeToolEvents}: only the
 * platform's own first-party runtime tools legitimately produce these, so any
 * event under {@link RUNTIME_TOOL_EVENTS_META_KEY} whose `type` is not in this
 * set is dropped rather than forwarded into the run's event sink.
 */
export const CANONICAL_RUNTIME_TOOL_EVENT_TYPES = [
  "output.emitted",
  // Emitted by the `publish_file` tool (and the entrypoint outputs sweep) once
  // a run file has been stored on the platform. Carries the durable file
  // metadata so ingestion persists a run_log the UI/chat can render.
  "file.published",
] as const;

/**
 * Membership form of {@link CANONICAL_RUNTIME_TOOL_EVENT_TYPES}, for the trust
 * boundary in `reEmitRuntimeToolEvents`.
 *
 * Named CANONICAL, not ACCEPTED: on a set whose whole job is to be closed, a name promising
 * a wider membership than it has is an invitation to add one back.
 */
const CANONICAL_RUNTIME_TOOL_EVENT_TYPE_SET: ReadonlySet<string> = new Set<string>(
  CANONICAL_RUNTIME_TOOL_EVENT_TYPES,
);

/** A canonical run event carried back from a runtime tool call. */
export interface RuntimeToolEvent {
  type: (typeof CANONICAL_RUNTIME_TOOL_EVENT_TYPES)[number];
  [k: string]: unknown;
}

/** The (text-only) result shape every runtime tool returns. */
export interface RuntimeToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
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
  handler: (rawArgs: unknown) => Promise<RuntimeToolResult>;
}

function withEvents(text: string, events: RuntimeToolEvent[]): RuntimeToolResult {
  // Stamp a production-time `timestamp` on every canonical event at the single
  // point they are wrapped: canonical run events carry a required `timestamp`,
  // and the re-emit path (`reEmitRuntimeToolEvents` → run sink) does not stamp
  // one. An event that already carries its own timestamp keeps it.
  const now = Date.now();
  const stamped = events.map((e) => ({ timestamp: now, ...e }));
  return {
    content: [{ type: "text", text }],
    _meta: { [RUNTIME_TOOL_EVENTS_META_KEY]: stamped },
  };
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
    handler: async (rawArgs) => {
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
      return withEvents("Output recorded", [
        { type: "output.emitted", data: data as Record<string, unknown> },
      ]);
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
 * itself (via `uploader`), then surfaces the canonical
 * `file.published` event under `_meta` so ingestion persists a run_log.
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
    handler: async (rawArgs) => {
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
      return withEvents(`Published ${file.name} → ${file.uri}`, [filePublishedEvent(file)]);
    },
  };
}

/**
 * Re-emit the canonical run events a runtime tool call returned under
 * {@link RUNTIME_TOOL_EVENTS_META_KEY}. Called by the runner's Pi wrapper so
 * the events land in the run's single event sink. No-op when the meta key is absent or malformed.
 */
export function reEmitRuntimeToolEvents(
  meta: Record<string, unknown> | undefined,
  emit: (event: RuntimeToolEvent) => void,
): void {
  const raw = meta?.[RUNTIME_TOOL_EVENTS_META_KEY];
  if (!Array.isArray(raw)) return;
  for (const ev of raw) {
    if (
      ev &&
      typeof ev === "object" &&
      typeof (ev as { type?: unknown }).type === "string" &&
      // Forward only the CLOSED canonical set: a type outside it is dropped.
      CANONICAL_RUNTIME_TOOL_EVENT_TYPE_SET.has((ev as { type: string }).type)
    ) {
      emit(ev as RuntimeToolEvent);
    }
  }
}
