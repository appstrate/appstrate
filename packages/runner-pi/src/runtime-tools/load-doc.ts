// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Platform-side loader for runtime-injected tool docs.
 *
 * Mirrors the bundle-tool contract: `TOOL.md` is a file co-located next
 * to `tool.ts`, resolved by the consumer (the platform prompt builder),
 * never inlined into the descriptor module. This is the runtime
 * equivalent of `pkg.files.get("TOOL.md")` in
 * `packages/afps-runtime/src/bundle/platform-prompt-inputs.ts`.
 *
 * Only imported from `apps/api` (which runs from source) — never from
 * the runtime-pi entrypoint that gets bundled via `bun build`, so the
 * `readFileSync(new URL(...))` pattern is safe here.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RuntimeInjectedTool } from "./types.ts";

/**
 * Map a tool's `name` (snake_case, MCP convention) to its on-disk
 * directory slug (kebab-case, filesystem convention).
 */
function toSlug(name: string): string {
  return name.replace(/_/g, "-");
}

/**
 * Read the co-located `TOOL.md` for a runtime-injected tool. Throws if
 * the file is missing — a missing doc is a packaging bug, not a
 * recoverable runtime condition.
 */
export function loadRuntimeToolDoc(tool: RuntimeInjectedTool): string {
  const slug = toSlug(tool.name);
  const url = new URL(`./${slug}/TOOL.md`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}
