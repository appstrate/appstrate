// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * AFPS 1.3 platform tools — spec-compliant Tool implementations for
 * the four reserved core domains (memory, state, output, log).
 *
 * In AFPS 1.3 these tools MOVE from hardcoded runtime extensions to
 * packages shipped in the bundle (`@afps/memory`, `@afps/state`, …).
 * Agents declare them in `dependencies.tools[]` and a `BundledToolResolver`
 * loads the code. This factory provides the same semantics as a set of
 * ready-to-use Tool objects — useful for:
 *
 *   - The Phase 3 packages (each ship the relevant factory entry directly)
 *   - Compat-mode auto-injection for pre-1.3 bundles that implicitly
 *     depended on the old hardcoded tools
 *   - Tests / in-memory runners that want the standard shapes without
 *     depending on the real packages
 *
 * Each tool simply emits a RunEvent — the EventSink decides what to do
 * (persist, broadcast, ignore). The runtime no longer hardcodes memory
 * / state / output / log semantics internally.
 */

import type { JSONSchema, Tool, ToolContext, ToolResult } from "./types.ts";

function successResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function emit(ctx: ToolContext, type: string, extra: Record<string, unknown>): void {
  ctx.emit({
    type,
    timestamp: Date.now(),
    runId: ctx.runId,
    ...(ctx.toolCallId !== undefined ? { toolCallId: ctx.toolCallId } : {}),
    ...extra,
  });
}

// ─────────────────────────────────────────────
// @afps/note — note → memory.added (AFPS 1.5+; replaces add_memory)
// ─────────────────────────────────────────────

export const noteTool: Tool = {
  name: "note",
  description:
    "Append a long-term archive memory — a discovery, fact, or user preference worth keeping across future runs. " +
    "Archive memories are NOT injected into the system prompt; retrieve them on demand with `recall_memory`. " +
    "Prefer bullet-sized entries (one fact per call). " +
    'Scope defaults to "actor" — well-suited for personal preferences (each actor sees only their own notes). ' +
    'Pass scope: "shared" for facts universal to the app (API quirks, org conventions, shared-resource structure) so every actor can recall them.',
  parameters: {
    type: "object",
    required: ["content"],
    additionalProperties: false,
    properties: {
      content: {
        type: "string",
        minLength: 1,
        description: "Memory content (max ~2000 chars).",
      },
      scope: {
        type: "string",
        enum: ["actor", "shared"],
        description:
          'Persistence scope. "actor" (default) keeps the note private to the calling actor — well-suited for personal preferences. "shared" makes the note visible to every actor of this app; use for facts universal regardless of who triggered the run.',
      },
    },
  } satisfies JSONSchema,
  async execute(args, ctx) {
    const { content, scope } = args as { content: string; scope?: "actor" | "shared" };
    emit(ctx, "memory.added", {
      content,
      ...(scope !== undefined ? { scope } : {}),
    });
    return successResult("Note saved");
  },
};

// ─────────────────────────────────────────────
// @afps/pin — pin → pinned.set (AFPS 1.5+; replaces set_checkpoint)
// ─────────────────────────────────────────────

export const pinTool: Tool = {
  name: "pin",
  description:
    "Upsert a named slot pinned into the system prompt on every run. Last-write-wins per `(scope, key)` — the most recent call fully replaces the previous value. " +
    'Use `key: "checkpoint"` for the carry-over slot snapshotted onto runs.checkpoint; other keys (e.g. "persona", "goals") are accepted and persisted as named pinned blocks. ' +
    'Scope defaults to "actor" — scheduled runs (under the schedule owner\'s identity), manual triggers, and different members each maintain their own private copy of the slot. ' +
    'Pass scope: "shared" when the slot tracks a resource shared across actors (a synced repo, a shared inbox, a shared database), otherwise the agent will desynchronise across triggers.',
  parameters: {
    type: "object",
    required: ["key", "content"],
    additionalProperties: false,
    properties: {
      key: {
        type: "string",
        minLength: 1,
        maxLength: 64,
        pattern: "^[a-z0-9_]+$",
        description:
          'Pinned slot identifier. Lowercase, digits and underscores only. "checkpoint" is reserved for the carry-over checkpoint slot.',
      },
      content: {
        description: "Arbitrary JSON value stored under the pinned slot.",
      },
      scope: {
        type: "string",
        enum: ["actor", "shared"],
        description:
          'Persistence scope. "actor" (default) gives every actor their own private copy of the slot — scheduled runs and manual triggers do not share state. "shared" makes the slot visible to every actor of this app; use when the slot tracks a resource shared across actors.',
      },
    },
  } satisfies JSONSchema,
  async execute(args, ctx) {
    const { key, content, scope } = args as {
      key: string;
      content: unknown;
      scope?: "actor" | "shared";
    };
    emit(ctx, "pinned.set", {
      key,
      content,
      ...(scope !== undefined ? { scope } : {}),
    });
    return successResult(`Pinned slot "${key}" updated`);
  },
};

// ─────────────────────────────────────────────
// @afps/output — output → output.emitted
// ─────────────────────────────────────────────

export const outputTool: Tool = {
  name: "output",
  description:
    "Emit a structured output value. Object fields are deep-merged with prior output events (JSON merge-patch); arrays and scalars replace wholesale.",
  parameters: {
    type: "object",
    required: ["data"],
    additionalProperties: false,
    properties: {
      data: { description: "Structured output — objects are merge-patched." },
    },
  } satisfies JSONSchema,
  async execute(args, ctx) {
    const { data } = args as { data: unknown };
    emit(ctx, "output.emitted", { data });
    return successResult("Output recorded");
  },
};

// ─────────────────────────────────────────────
// @afps/log — log → log.written
// ─────────────────────────────────────────────

export const logTool: Tool = {
  name: "log",
  description:
    "Emit a log entry with a severity level. Useful for observability — logs surface in the final RunResult but are not part of the output deliverable.",
  parameters: {
    type: "object",
    required: ["level", "message"],
    additionalProperties: false,
    properties: {
      level: { type: "string", enum: ["info", "warn", "error"] },
      message: { type: "string", minLength: 1 },
    },
  } satisfies JSONSchema,
  async execute(args, ctx) {
    const { level, message } = args as { level: "info" | "warn" | "error"; message: string };
    emit(ctx, "log.written", { level, message });
    return successResult("Logged");
  },
};

// ─────────────────────────────────────────────
// Bundle / selector
// ─────────────────────────────────────────────

/**
 * The four platform tools keyed by tool name, suitable for
 * `RunOptions.toolOverrides`. Spread directly into the overrides map
 * when a runner needs to inject all four at once.
 */
export const PLATFORM_TOOLS = {
  note: noteTool,
  pin: pinTool,
  output: outputTool,
  log: logTool,
} as const satisfies Record<string, Tool>;
