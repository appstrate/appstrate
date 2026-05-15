// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Platform-side loader for runtime-injected tool docs.
 *
 * Mirrors the bundle-tool contract: `TOOL.md` is a file co-located in
 * the tool's directory, resolved by the consumer (the platform prompt
 * builder), never inlined into the descriptor module. This is the
 * runtime equivalent of `pkg.files.get("TOOL.md")` in
 * `packages/afps-runtime/src/bundle/platform-prompt-inputs.ts`.
 *
 * The descriptor carries `dirUrl` (the tool's directory, captured at
 * tool-module load time via `defineTool(import.meta, …)`), so this
 * loader is a thin filesystem read with no naming-convention
 * assumptions.
 *
 * Only imported from `apps/api` (which runs from source) — never from
 * the runtime-pi entrypoint that gets bundled via `bun build`, so the
 * `readFileSync` pattern is safe here.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimeInjectedTool } from "./types.ts";

/**
 * Read the co-located `TOOL.md` for a runtime-injected tool. Throws if
 * the file is missing — a missing doc is a packaging bug, not a
 * recoverable runtime condition.
 */
export function loadRuntimeToolDoc(tool: RuntimeInjectedTool): string {
  return readFileSync(join(fileURLToPath(tool.dirUrl), "TOOL.md"), "utf8");
}
