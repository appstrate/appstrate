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
    "Save a durable memory — a discovery, fact, or user preference worth keeping across future runs. Prefer bullet-sized entries (one fact per call).",
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
    },
  } satisfies JSONSchema,
  async execute(args, ctx) {
    const { content } = args as { content: string };
    emit(ctx, "memory.added", { content });
    return successResult("Memory saved");
  },
};

// ─────────────────────────────────────────────
// @afps/state — set_state → state.set
// ─────────────────────────────────────────────

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
 * The full set of legacy-compatible platform tools keyed by tool name.
 * A runner can spread this into `toolOverrides` when running a pre-1.3
 * bundle that implicitly depended on the hardcoded tools, while a 1.3
 * bundle declaring its dependencies explicitly gets the same behaviour
 * via the bundled tool packages.
 */
export const PLATFORM_TOOLS = {
  add_memory: memoryTool,
  set_state: stateTool,
  output: outputTool,
  report: reportTool,
  log: logTool,
} as const satisfies Record<string, Tool>;

/** Return a Record<toolName, Tool> suitable for `RunOptions.toolOverrides`. */
export function platformToolOverrides(): Record<string, Tool> {
  return { ...PLATFORM_TOOLS };
}
