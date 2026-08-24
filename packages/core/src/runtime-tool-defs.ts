// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Runtime tool definitions — the platform's first-party "runtime tools"
 * expressed as transport-neutral, Pi-agnostic MCP tool definitions.
 *
 * Two groups, both defined here: the four pure event emitters
 * (`output` / `log` / `note` / `pin`), assembled together by
 * {@link buildRuntimeToolDefs}; and `publish_file`, built on its own by
 * {@link buildPublishFileDef} because it needs an injected HTTP uploader
 * only the runtime entrypoint can supply.
 *
 * These were previously Pi-SDK extension factories baked into the runtime
 * image (`@appstrate/runner-pi/runtime-tools/builtin/*`). They are now plain
 * tool definitions so the SAME logic can be hosted two ways:
 *
 *   1. As in-process MCP tools served by the credential-isolating sidecar
 *      (`runtime-pi/sidecar/server.ts`), exposed on the agent-facing `/mcp`
 *      surface alongside `run_history` / `recall_memory` and the
 *      integration tools. Any harness that speaks MCP gets them for free —
 *      this is what decouples the runtime tools from the Pi SDK.
 *   2. As Pi extensions registered directly in the agent for the
 *      no-sidecar execution path (`runtime-pi/entrypoint.ts` skip-sidecar
 *      branch + the public `appstrate run` CLI), via the thin wrapper in
 *      `@appstrate/runner-pi/runtime-tools/runtime-tool-extensions`.
 *
 * Both adapters share this module's per-tool logic (input schema +
 * validation + the canonical run events each call produces), so there is a
 * single source of truth for these event-emitter tools.
 *
 * Event delivery: a tool call NEVER emits directly. It returns the
 * canonical run events under the result `_meta` key
 * {@link RUNTIME_TOOL_EVENTS_META_KEY}; the host re-emits them into the
 * run's single event sink (the sidecar path relays them agent-side via
 * `reEmitRuntimeToolEvents`; the no-sidecar Pi wrapper does the same). This
 * keeps a single sequence source for the run-event pipeline — no behavioural
 * change to ingestion, the reducer, or finalize.
 *
 * Lives in `@appstrate/core` (dependency-light, already ships `ajv`) so the
 * sidecar can import it without pulling the Pi SDK into its bundle.
 */

import type { ValidateFunction } from "ajv";
import { asJSONSchemaObject } from "./form.ts";
import { compileCached } from "./schema-validation.ts";
import {
  EVENT_EMITTER_RUNTIME_TOOLS,
  type EventEmitterRuntimeTool,
} from "./runtime-tools-catalog.ts";
import type { RunAndWaitFile } from "./run-and-wait-client.ts";

/**
 * MCP `_meta` key under which a runtime tool call surfaces the canonical
 * run events it produced (`output.emitted`, `log.written`, `memory.added`,
 * `pinned.set`). The agent-side bridge reads this key
 * and re-emits each event into the run's event sink.
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
  "log.written",
  "memory.added",
  "pinned.set",
  // Emitted by the `publish_file` tool (and the entrypoint outputs sweep) once
  // a run file has been stored on the platform. Carries the durable file
  // metadata so ingestion persists a run_log the UI/chat can render.
  "file.published",
] as const;

/**
 * Membership form of {@link CANONICAL_RUNTIME_TOOL_EVENT_TYPES}, for the trust
 * boundary in `reEmitRuntimeToolEvents`.
 *
 * Named CANONICAL, not ACCEPTED. It was briefly the latter, when it also held
 * the pre-#1177 `document.published` spelling; that member is gone and the
 * name outlived it. On a set whose whole job is to be closed, a name promising
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
 * `@appstrate/mcp-transport`'s `AppstrateToolDefinition` (the sidecar uses
 * it directly) without coupling core to the transport package.
 */
export interface RuntimeToolDef {
  descriptor: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  };
  handler: (rawArgs: unknown) => Promise<RuntimeToolResult>;
}

export interface BuildRuntimeToolDefsOptions {
  /** Agent-selected runtime tools (`manifest.runtime_tools`). */
  runtimeTools?: readonly string[];
  /**
   * Output JSON Schema. When set, it becomes `output`'s `data` argument
   * schema (the model sees it in the tool definition) and calls are
   * AJV-validated against it. `null`/omitted leaves `output` accepting any
   * JSON object.
   */
  outputSchema?: Record<string, unknown> | null;
}

function withEvents(text: string, events: RuntimeToolEvent[]): RuntimeToolResult {
  // Stamp a production-time `timestamp` on every canonical event at the single
  // point they are wrapped. Canonical run events (`log.written`, …) carry a
  // required `timestamp` (consumed by the reducer → RunResult.logs), but the
  // sidecar/MCP re-emit path (`reEmitRuntimeToolEvents` → bridged sink) does
  // not stamp one — unlike the no-sidecar stdout path. An event left without a
  // timestamp surfaced as `undefined` in the finalize RunResult and failed the
  // whole run. Stamping here fixes both paths; an event that already carries
  // its own timestamp keeps it.
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

function buildOutputDef(outputSchema: Record<string, unknown> | null): RuntimeToolDef {
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
  if (outputSchema) {
    try {
      validator = compileCached(asJSONSchemaObject(outputSchema));
    } catch (err) {
      schemaCompileError = err instanceof Error ? err.message : String(err);
    }
  }
  const dataSchema: Record<string, unknown> = outputSchema
    ? {
        ...outputSchema,
        description:
          typeof outputSchema.description === "string"
            ? outputSchema.description
            : "JSON object to return as the run output",
      }
    : { type: "object", description: "JSON object to return as the run output" };
  // `output` is opt-in (selected via `runtimeTools`). When a run declares an
  // output schema the agent MUST call it (once, valid); otherwise it may
  // finish without it (a side-effect-only run is a valid success).
  const description = outputSchema
    ? "Call exactly once, as your final action, with the complete output object that " +
      "satisfies the declared schema (all required fields must be provided). A successful " +
      "call ends the run immediately — do all other work first."
    : "Optional — call at most once, as your final action, to return a JSON object as the " +
      "run result. If your task produces no result to return, finish without calling it. " +
      "A successful call ends the run immediately — do all other work first.";
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

function buildLogDef(): RuntimeToolDef {
  return {
    descriptor: {
      name: "log",
      description:
        "Send a progress message to the user. Write naturally — the user reads these in real time.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["level", "message"],
        properties: {
          level: {
            type: "string",
            enum: ["info", "warn", "error"],
            description:
              "info: progress and milestones, warn: non-blocking issues, error: failures",
          },
          message: { type: "string", description: "Message for the user" },
        },
      },
    },
    handler: async (rawArgs) => {
      const { level, message } = (rawArgs ?? {}) as {
        level: "info" | "warn" | "error";
        message: string;
      };
      return withEvents(`Logged [${level}]: ${message}`, [{ type: "log.written", level, message }]);
    },
  };
}

function buildNoteDef(): RuntimeToolDef {
  return {
    descriptor: {
      name: "note",
      description:
        "Append a long-term archive memory — a discovery, fact, or user preference worth keeping across future runs. " +
        "Archive memories are NOT injected into the system prompt; retrieve them on demand with `recall_memory`. " +
        'Scope defaults to "actor" — personal observations stay private to the calling actor (scheduled runs, ' +
        "manual triggers, and different members each see only their own notes). " +
        'Pass scope="shared" for facts universal to the app — API quirks, org conventions, shared-resource structure — ' +
        "so every actor can recall them. " +
        "Use for insights worth remembering (e.g. 'Gmail API paginates at 100 results', 'User prefers CSV format').",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["content"],
        properties: {
          content: { type: "string", description: "Memory text to save (max 2000 characters)" },
          scope: {
            type: "string",
            enum: ["actor", "shared"],
            description:
              'Persistence scope. "actor" (default) keeps the note private to the calling actor — well-suited for personal preferences. "shared" makes the note visible to every actor of the app; use for facts universal regardless of who triggered the run.',
          },
        },
      },
    },
    handler: async (rawArgs) => {
      const { content, scope } = (rawArgs ?? {}) as { content: string; scope?: "actor" | "shared" };
      const event: RuntimeToolEvent = { type: "memory.added", content };
      if (scope !== undefined) event.scope = scope;
      return withEvents("Note saved", [event]);
    },
  };
}

function buildPinDef(): RuntimeToolDef {
  return {
    descriptor: {
      name: "pin",
      description:
        "Upsert a named slot pinned into the system prompt on every run. Last-write-wins per (scope, key). " +
        'Use key="checkpoint" for the carry-over checkpoint; other keys (e.g. "persona", "goals") create additional pinned blocks. ' +
        'Scope defaults to "actor" — scheduled runs, manual triggers, and different members each get their own copy. ' +
        'Pass scope="shared" when the slot tracks a resource shared across actors (synced repo, shared inbox, shared DB), ' +
        "otherwise the agent will desynchronise across triggers.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["key", "content"],
        properties: {
          key: {
            type: "string",
            minLength: 1,
            maxLength: 64,
            pattern: "^[a-z0-9_]+$",
            description:
              'Pinned slot identifier. Lowercase, digits and underscores only. "checkpoint" is the carry-over slot.',
          },
          content: { description: "Arbitrary JSON value stored under the pinned slot." },
          scope: {
            type: "string",
            enum: ["actor", "shared"],
            description:
              'Persistence scope. "actor" (default) gives every actor their own private copy of the slot — scheduled runs, manual triggers, and different members do not share state. "shared" makes the slot app-wide; use when the slot tracks a resource shared across actors.',
          },
        },
      },
    },
    handler: async (rawArgs) => {
      const { key, content, scope } = (rawArgs ?? {}) as {
        key: string;
        content: unknown;
        scope?: "actor" | "shared";
      };
      const event: RuntimeToolEvent = { type: "pinned.set", key, content };
      if (scope !== undefined) event.scope = scope;
      return withEvents(`Pinned slot "${key}" updated`, [event]);
    },
  };
}

const RUNTIME_TOOL_BUILDERS: Record<
  EventEmitterRuntimeTool,
  (outputSchema: Record<string, unknown> | null) => RuntimeToolDef
> = {
  output: (s) => buildOutputDef(s),
  log: () => buildLogDef(),
  note: () => buildNoteDef(),
  pin: () => buildPinDef(),
};

/**
 * Build the {@link RuntimeToolDef}s for an agent's selected runtime tools.
 * Only the pure event-emitter tools are built here — `publish_file` is
 * excluded (it needs an injected uploader; the entrypoint builds it). Unknown
 * entries are ignored — that is the contract that keeps a manifest naming a
 * retired tool (e.g. the removed `report`) runnable; `validateManifest` drops
 * the same ids rather than rejecting the manifest. Order follows the agent's
 * selection, de-duplicated.
 */
export function buildRuntimeToolDefs(opts: BuildRuntimeToolDefsOptions): RuntimeToolDef[] {
  const outputSchema = opts.outputSchema ?? null;
  const selected: EventEmitterRuntimeTool[] = [];
  const seen = new Set<string>();
  for (const entry of opts.runtimeTools ?? []) {
    if (seen.has(entry)) continue;
    if ((EVENT_EMITTER_RUNTIME_TOOLS as readonly string[]).includes(entry)) {
      seen.add(entry);
      selected.push(entry as EventEmitterRuntimeTool);
    }
  }
  return selected.map((name) => RUNTIME_TOOL_BUILDERS[name](outputSchema));
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
  file_id: string;
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
    file_id: file.id,
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
 * {@link FileUploader}. Unlike the pure event emitters this tool performs
 * the upload itself (via `uploader`), then surfaces the canonical
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
 * {@link RUNTIME_TOOL_EVENTS_META_KEY}. Called by the host (agent-side MCP
 * bridge or the no-sidecar Pi wrapper) so the events land in the run's
 * single event sink. No-op when the meta key is absent or malformed.
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
      // Trust boundary: forward only the CLOSED canonical set. A type outside
      // it is dropped — it can only come from an untrusted upstream attempting
      // to forge a run event.
      CANONICAL_RUNTIME_TOOL_EVENT_TYPE_SET.has((ev as { type: string }).type)
    ) {
      emit(ev as RuntimeToolEvent);
    }
  }
}
