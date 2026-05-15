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
 * Each descriptor self-locates its `TOOL.md` via `docUrl`, captured at
 * tool-module load time from the tool's own `import.meta.url`. No
 * naming-convention-based path reconstruction — moving or renaming a
 * tool directory does not require updating a separate path map.
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
   * Absolute URL of the tool's directory (the unit of co-location —
   * `tool.ts`, `TOOL.md`, and any future sibling files all sit here).
   * Captured at tool-module load time via
   * `new URL(".", import.meta.url)`, so the descriptor self-anchors
   * without relying on any naming-convention path reconstruction.
   * The platform reads files under it (currently `TOOL.md` via
   * `loadRuntimeToolDoc(tool)`); the bundled runtime entrypoint never
   * reads them — it only consumes name/description/parameters.
   */
  readonly dirUrl: URL;
}
