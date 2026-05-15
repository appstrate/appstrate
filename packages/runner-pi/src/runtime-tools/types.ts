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
 *       TOOL.md    ← prose loaded by the platform at prompt-build time
 *
 * The descriptor stays free of `doc` on purpose: `TOOL.md` is read by
 * the consumer (the platform prompt builder, via `loadRuntimeToolDoc`),
 * exactly like bundle tools where the platform reads `TOOL.md` from
 * the package's file map (`pkg.files.get("TOOL.md")`). This keeps
 * runtime-pi's bundled entrypoint slim — it never carries doc strings
 * it doesn't use.
 *
 * The three fields below are sufficient for both consumers:
 *   - The platform prompt builder uses `id`/`name`/`description` for
 *     `availableTools` and pairs each tool with its `TOOL.md` via
 *     `loadRuntimeToolDoc` when extending `toolDocs`.
 *   - The runtime container uses `name`/`description`/`parameters` to
 *     register a generic MCP-forwarding Pi tool via
 *     `runtime-tools/mcp-forward.ts:buildRuntimeToolFactories`.
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
}
