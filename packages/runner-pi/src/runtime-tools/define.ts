// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Factory for runtime-injected tool descriptors.
 *
 * Each tool's `tool.ts` is conceptually pure metadata, but the
 * descriptor also needs to know where its own directory lives on disk
 * so the platform prompt builder can read the co-located `TOOL.md`
 * (mirroring how bundle tools expose files via `pkg.files.get(...)`).
 *
 * The only entity that knows a module's true on-disk location is the
 * module itself, via `import.meta.url`. This helper captures it once,
 * so tool.ts files stay focused on metadata and never duplicate path
 * conventions or naming heuristics.
 *
 * Usage:
 *
 *   export const myTool = defineTool(import.meta, {
 *     id: "my_tool",
 *     name: "my_tool",
 *     description: "...",
 *     parameters: { type: "object", properties: { ... } },
 *   });
 */

import type { RuntimeInjectedTool } from "./types.ts";

export function defineTool(
  meta: ImportMeta,
  descriptor: Omit<RuntimeInjectedTool, "dirUrl">,
): RuntimeInjectedTool {
  return { ...descriptor, dirUrl: new URL(".", meta.url) };
}
