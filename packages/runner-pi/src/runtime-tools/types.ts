// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Descriptor for a tool wired by the runtime container outside of any
 * AFPS bundle package (`run_history`, `recall_memory`). The descriptor
 * is pure metadata: name + description + parameter schema. The
 * `description` is the LLM-facing doc — the agent discovers the tool and
 * its usage via MCP `tools/list`, so there is no co-located `TOOL.md`
 * and no prompt injection.
 */
export interface RuntimeInjectedTool {
  /** Stable tool id — same string used as `id` and `name` since these tools have no package identity. */
  readonly id: string;
  /** LLM-facing tool name. Must match what the sidecar advertises via MCP. */
  readonly name: string;
  /** Short description — the LLM-facing doc, advertised via MCP `tools/list`. */
  readonly description: string;
  /**
   * JSON Schema for the tool's `arguments` payload (i.e. the LLM-facing
   * call surface). Used by the runtime container to register the Pi
   * tool with the same shape the sidecar advertises via MCP. Plain
   * JSON Schema so this module stays free of Pi-AI / typebox imports —
   * the runtime wraps it with `Type.Unsafe(schema)` at registration.
   */
  readonly parameters: Readonly<Record<string, unknown>>;
}
