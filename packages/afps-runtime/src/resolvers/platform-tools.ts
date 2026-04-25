// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * AFPS 1.3 platform tools — spec-compliant Tool implementations for
 * the five reserved core domains (memory, state, output, report, log).
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
 * / state / output / report / log semantics internally.
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
// @afps/memory — add_memory → memory.added
// ─────────────────────────────────────────────

export const memoryTool: Tool = {
  name: "add_memory",
  description:
    "Save a durable memory — a discovery, fact, or user preference worth keeping across future runs. Prefer bullet-sized entries (one fact per call). " +
    'By default memories are scoped to the current actor (the user or end-user that triggered the run); pass scope: "shared" for app-wide memories every actor will see.',
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
          'Persistence scope. "actor" (default) keeps the memory private to the run\'s actor; "shared" makes it visible to every actor of this app.',
      },
    },
  } satisfies JSONSchema,
  async execute(args, ctx) {
    const { content, scope } = args as { content: string; scope?: "actor" | "shared" };
    emit(ctx, "memory.added", {
      content,
      ...(scope !== undefined ? { scope } : {}),
    });
    return successResult("Memory saved");
  },
};

// ─────────────────────────────────────────────
// @afps/checkpoint — set_checkpoint → checkpoint.set (AFPS 1.4+)
// ─────────────────────────────────────────────

export const checkpointTool: Tool = {
  name: "set_checkpoint",
  description:
    "Overwrite the agent's carry-over checkpoint for the next run. Last-write-wins; the most recent call fully replaces any previous checkpoint. " +
    'By default the checkpoint is scoped to the current actor (the user or end-user that triggered the run); pass scope: "shared" for an app-wide checkpoint shared across all actors.',
  parameters: {
    type: "object",
    required: ["data"],
    additionalProperties: false,
    properties: {
      data: {
        description: "Arbitrary JSON value stored as the carry-over checkpoint.",
      },
      scope: {
        type: "string",
        enum: ["actor", "shared"],
        description:
          'Persistence scope. "actor" (default) keeps the checkpoint private to the run\'s actor; "shared" makes it visible to every actor of this app.',
      },
    },
  } satisfies JSONSchema,
  async execute(args, ctx) {
    const { data, scope } = args as { data: unknown; scope?: "actor" | "shared" };
    emit(ctx, "checkpoint.set", {
      data,
      ...(scope !== undefined ? { scope } : {}),
    });
    return successResult("Checkpoint updated");
  },
};

/**
 * @deprecated Pre-AFPS-1.4 alias kept so already-published bundles that
 * declare `@appstrate/set-state@1.0.0` keep loading. The runtime accepts
 * both `state.set` and `checkpoint.set` events; this tool emits the
 * legacy event for back-compat. New bundles should depend on
 * `@appstrate/set-checkpoint@2.0.0` and use {@link checkpointTool}.
 */
export const stateTool: Tool = {
  name: "set_state",
  description:
    "Overwrite the agent's carry-over state for the next run. Last-write-wins; the most recent call fully replaces any previous state.",
  parameters: {
    type: "object",
    required: ["state"],
    additionalProperties: false,
    properties: {
      state: {
        description: "Arbitrary JSON value stored as carry-over state.",
      },
    },
  } satisfies JSONSchema,
  async execute(args, ctx) {
    const { state } = args as { state: unknown };
    emit(ctx, "state.set", { state });
    return successResult("State updated");
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
// @afps/report — report → report.appended
// ─────────────────────────────────────────────

export const reportTool: Tool = {
  name: "report",
  description:
    "Append a line to the human-readable run report. Lines are concatenated with newline separators in the final RunResult.",
  parameters: {
    type: "object",
    required: ["content"],
    additionalProperties: false,
    properties: {
      content: { type: "string", description: "One line of the human-readable report." },
    },
  } satisfies JSONSchema,
  async execute(args, ctx) {
    const { content } = args as { content: string };
    emit(ctx, "report.appended", { content });
    return successResult("Report line appended");
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
 * The five platform tools keyed by tool name, suitable for
 * `RunOptions.toolOverrides`. Spread directly into the overrides map
 * when a runner needs to inject all five at once.
 */
export const PLATFORM_TOOLS = {
  add_memory: memoryTool,
  set_checkpoint: checkpointTool,
  // `set_state` is the deprecated AFPS ≤ 1.3 name. Kept in the catalogue
  // so bundles declaring `@appstrate/set-state@1.0.0` keep resolving;
  // emits the legacy `state.set` event which the reducer aliases to
  // `checkpoint.set`. Remove when the floor of supported bundles ≥ 1.4.
  set_state: stateTool,
  output: outputTool,
  report: reportTool,
  log: logTool,
} as const satisfies Record<string, Tool>;
