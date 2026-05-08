// SPDX-License-Identifier: Apache-2.0

/**
 * Appstrate platform system prompt — thin shim over the runtime's
 * `buildPlatformPromptInputs` + `renderPlatformPrompt`. Derivation of
 * every section (System / Environment / Tools / Skills / Providers /
 * Input / Documents / Config / Checkpoint / Memory / Output Format) happens
 * in the runtime from the parsed Bundle; this function only adds the
 * overrides that are platform-specific:
 *
 *   - `platformName`: `"Appstrate"`
 *   - `uploads`: DB-stored files with platform-sanitised paths
 *   - `providers`: filtered to those with wired credentials
 *     (`plan.tokens[p.id]`) and enriched with authorized URIs via
 *     `@appstrate/connect`. Replaces the bundle-derived provider list
 *     via `providersReplace: true` so disconnected providers never
 *     reach the LLM prompt.
 *
 * Every other field flows straight from the bundle — the same code
 * path used by the `appstrate run` CLI. Divergence between platform
 * and CLI is now strictly the three overrides above.
 *
 * Run history is NOT rendered in the prompt: the runtime wires a
 * typed `run_history` tool (see runtime-pi/entrypoint.ts Phase D) whose
 * description self-documents the capability — the agent never sees the
 * sidecar URL.
 */

import type { AppstrateRunPlan } from "./types.ts";
import type { ExecutionContext } from "@appstrate/afps-runtime/types";
import { buildPlatformPromptInputs, renderPlatformPrompt } from "@appstrate/afps-runtime/bundle";
import type { PlatformPromptProvider, PlatformPromptTool } from "@appstrate/afps-runtime/bundle";
import { sanitizeStorageKey } from "../file-storage.ts";

/**
 * Tools the runtime container wires unconditionally for every platform
 * run. They are NOT shipped as bundle packages, so `buildPlatformPrompt-
 * Inputs` cannot derive them from the bundle. We surface them here so
 * the gating in `renderPlatformPrompt` (#368) sees them — without this
 * the prompt would omit `## Memory` for agents that don't ship
 * `@appstrate/note` even though `recall_memory` is always available.
 *
 * Keep this in sync with `runtime-pi/mcp/direct.ts`:
 * `buildMcpDirectFactories` always registers `run_history` and
 * `recall_memory`. The `provider_call` tool is conditional on the
 * bundle declaring at least one provider — handled separately so we
 * don't surface it when the prompt has no `## Connected Providers`
 * section to back it.
 */
const PLATFORM_INJECTED_TOOLS: ReadonlyArray<PlatformPromptTool> = [
  {
    id: "run_history",
    name: "run_history",
    description: "Fetch metadata and optionally checkpoint/result of recent past runs.",
  },
  {
    id: "recall_memory",
    name: "recall_memory",
    description:
      "Search the agent's archive memories — durable facts and learnings from past runs.",
  },
];

export function buildPlatformSystemPrompt(
  context: ExecutionContext,
  plan: AppstrateRunPlan,
): string {
  // Project ProviderSummary → PlatformPromptProvider explicitly: drop the
  // platform-internal credential bag (credentialSchema / credentialFieldName /
  // credentialHeaderName / credentialHeaderPrefix / categories) so it never
  // reaches the prompt-rendering pipeline.
  const connectedProviders: PlatformPromptProvider[] = plan.providers
    .filter((p) => plan.tokens[p.id])
    .map((p) => ({
      id: p.id,
      displayName: p.displayName,
      authMode: p.authMode,
      ...(p.authorizedUris?.length ? { authorizedUris: p.authorizedUris } : {}),
      allowAllUris: p.allowAllUris ?? false,
      ...(p.docsUrl !== undefined ? { docsUrl: p.docsUrl } : {}),
    }));

  const uploads = plan.files?.map((f) => ({
    name: f.name,
    path: `./documents/${sanitizeStorageKey(f.name)}`,
    size: f.size,
    ...(f.type ? { type: f.type } : {}),
  }));

  const inputs = buildPlatformPromptInputs(plan.bundle, context, {
    platformName: "Appstrate",
    timeoutSeconds: plan.timeout,
    providers: connectedProviders,
    providersReplace: true,
    ...(uploads ? { uploads } : {}),
  });

  // Append platform-injected runtime tools. Done AFTER bundle derivation
  // so bundle-declared tools (incl. dependency-shipped `pin`/`note`)
  // appear first in the `### Tools` listing — same order they're
  // discoverable to the LLM via `tools/list`.
  inputs.availableTools = [...(inputs.availableTools ?? []), ...PLATFORM_INJECTED_TOOLS];

  return renderPlatformPrompt(inputs);
}
