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
import { RUNTIME_INJECTED_TOOLS, loadRuntimeToolDoc } from "@appstrate/runner-pi";
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

  // Inject runtime-wired tools (run_history, recall_memory) that are
  // not bundle packages. Both `availableTools` and `toolDocs` are
  // appended AFTER bundle-derived entries so user-shipped tools come
  // first in the `### Tools` listing and have their TOOL.md rendered
  // ahead of the runtime docs — same order they're discoverable via
  // MCP `tools/list`.
  //
  // `TOOL.md` is resolved here via `loadRuntimeToolDoc`, mirroring how
  // bundle tools expose their doc through `pkg.files.get("TOOL.md")`:
  // the descriptor never carries the doc string — the platform is the
  // single point that reads it.
  inputs.availableTools = [
    ...(inputs.availableTools ?? []),
    ...RUNTIME_INJECTED_TOOLS.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
    })),
  ];
  inputs.toolDocs = [
    ...(inputs.toolDocs ?? []),
    ...RUNTIME_INJECTED_TOOLS.map((t) => ({ id: t.id, content: loadRuntimeToolDoc(t) })),
  ];

  return renderPlatformPrompt(inputs);
}
