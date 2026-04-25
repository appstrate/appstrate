// SPDX-License-Identifier: Apache-2.0

/**
 * Appstrate platform system prompt — thin shim over the runtime's
 * `buildPlatformPromptInputs` + `renderPlatformPrompt`. Derivation of
 * every section (System / Environment / Tools / Skills / Providers /
 * Input / Documents / Config / State / Memory / Output Format) happens
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
import type { PlatformPromptProvider } from "@appstrate/afps-runtime/bundle";
import { sanitizeStorageKey } from "../file-storage.ts";

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
      ...(p.hasProviderDoc !== undefined ? { hasProviderDoc: p.hasProviderDoc } : {}),
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

  return renderPlatformPrompt(inputs);
}
