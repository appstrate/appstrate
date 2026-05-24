// SPDX-License-Identifier: Apache-2.0

/**
 * Appstrate platform system prompt — thin shim over the runtime's
 * `buildPlatformPromptInputs` + `renderPlatformPrompt`. Derivation of
 * every section (System / Environment / Tools / Skills / Input /
 * Documents / Config / Checkpoint / Memory / Output Format) happens in
 * the runtime from the parsed Bundle; this function only adds the
 * overrides that are platform-specific:
 *
 *   - `platformName`: `"Appstrate"`
 *   - `uploads`: DB-stored files with platform-sanitised paths
 *
 * Every other field flows straight from the bundle — the same code
 * path used by the `appstrate run` CLI. Divergence between platform
 * and CLI is now strictly the two overrides above. Outbound API access
 * is surfaced via integration MCP tools (`{ns}__api_call`), not the
 * prompt.
 *
 * Run history is NOT rendered in the prompt: the runtime wires a
 * typed `run_history` tool (see runtime-pi/entrypoint.ts Phase D) whose
 * description self-documents the capability — the agent never sees the
 * sidecar URL.
 */

import type { AppstrateRunPlan } from "./types.ts";
import type { ExecutionContext } from "@appstrate/afps-runtime/types";
import { buildPlatformPromptInputs, renderPlatformPrompt } from "@appstrate/afps-runtime/bundle";
import { sanitizeStorageKey } from "../file-storage.ts";

export function buildPlatformSystemPrompt(
  context: ExecutionContext,
  plan: AppstrateRunPlan,
): string {
  const uploads = plan.files?.map((f) => ({
    name: f.name,
    path: `./documents/${sanitizeStorageKey(f.name)}`,
    size: f.size,
    ...(f.type ? { type: f.type } : {}),
  }));

  const inputs = buildPlatformPromptInputs(plan.bundle, context, {
    platformName: "Appstrate",
    timeoutSeconds: plan.timeout,
    ...(uploads ? { uploads } : {}),
  });

  // The agent's tools — runtime-wired (`run_history`, `recall_memory`),
  // integration tools, and the platform runtime tools (output/log/note/
  // pin/report) — are all advertised to the model via MCP `tools/list`
  // (name + description + input schema), so the prompt no longer lists
  // them. The Communication contract (rendered above) is the only
  // tool-related instruction the model can't infer from `tools/list`, and
  // it stays. This keeps a single source of truth for each tool's
  // signature and avoids a stale/partial in-prompt list that would
  // contradict the live tool set.
  return renderPlatformPrompt(inputs);
}
