// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Descriptor for a tool wired by the runtime container outside of any
 * AFPS bundle package. Each runtime-injected tool ships its descriptor
 * + co-located `TOOL.md` in its own directory under `runtime-tools/`,
 * mirroring the layout of bundle tool packages
 * (`scripts/system-packages/tool-<name>-<version>/`):
 *
 *   runtime-tools/
 *     <tool-slug>/
 *       tool.ts    ← descriptor (this type)
 *       TOOL.md    ← prose imported via Bun text-import
 *
 * The four fields are sufficient for both consumers:
 *   - The platform prompt builder uses `id`/`name`/`description`/`doc`
 *     to extend `availableTools` and `toolDocs`.
 *   - The runtime container uses `name`/`description`/`parameters` to
 *     register a generic MCP-forwarding Pi tool via
 *     `runtime-pi/mcp/direct.ts:makeMcpForwardExtension`.
 *
 * Adding a new runtime-injected tool means creating a new directory
 * with `tool.ts` + `TOOL.md` and importing it from `runtime-tools/
 * index.ts`. No edits anywhere else.
 */
export interface RuntimeInjectedTool {
  /** Stable tool id — same string used as `id` and `name` since these tools have no package identity. */
  readonly id: string;
  /** LLM-facing tool name. Must match what the sidecar advertises via MCP. */
  readonly name: string;
  /** Short description shown in the `### Tools` listing and in MCP tool advertisements. */
  readonly description: string;
  /**
   * JSON Schema for the tool's `arguments` payload (i.e. the LLM-facing
   * call surface). Used by the runtime container to register the Pi
   * tool with the same shape the sidecar advertises via MCP. Plain
   * JSON Schema so this module stays free of Pi-AI / typebox imports —
   * the runtime wraps it with `Type.Unsafe(schema)` at registration.
   */
  readonly parameters: Readonly<Record<string, unknown>>;
  /**
   * `TOOL.md`-equivalent doc: a complete prose fragment that teaches
   * the LLM how to use the tool — parameters, scoping, common
   * patterns. Rendered alongside bundle `TOOL.md`s in the platform
   * prompt's tool-doc area. Conventionally loaded from a co-located
   * `TOOL.md` file via `readFileSync(new URL("./TOOL.md", import.meta.url))`
   * at module-import time. Should start with a level-2 markdown
   * heading (`## tool_name`) for visual parity with bundle docs.
   */
  readonly doc: string;
}
