// SPDX-License-Identifier: Apache-2.0

/**
 * Appstrate platform system prompt — thin shim over the runtime's
 * `renderPlatformPrompt`. The platform owns: provider URL pattern
 * resolution (via `@appstrate/connect`), upload path layout (via
 * `sanitizeStorageKey`), and the sidecar-based run-history surface.
 * Every other section (System / Tools / Skills / Providers / Input /
 * Documents / Config / State / Memory / Run History) is composed by
 * the runtime.
 */

import type { AppstrateRunPlan } from "./types.ts";
import type { ExecutionContext } from "@appstrate/afps-runtime/types";
import { renderPlatformPrompt } from "@appstrate/afps-runtime/bundle";
import type { PlatformPromptProvider } from "@appstrate/afps-runtime/bundle";
import { getDefaultAuthorizedUris, type ProviderDefinition } from "@appstrate/connect";
import { sanitizeStorageKey } from "../file-storage.ts";

export function buildPlatformSystemPrompt(
  context: ExecutionContext,
  plan: AppstrateRunPlan,
): string {
  const connected: PlatformPromptProvider[] = plan.providers
    .filter((p) => plan.tokens[p.id])
    .map((p) => {
      const uris = getDefaultAuthorizedUris(p as ProviderDefinition);
      return {
        id: p.id,
        displayName: p.displayName,
        authMode: p.authMode,
        ...(uris ? { authorizedUris: uris } : {}),
        allowAllUris: p.allowAllUris ?? false,
        ...(p.docsUrl !== undefined ? { docsUrl: p.docsUrl } : {}),
        ...(p.hasProviderDoc !== undefined ? { hasProviderDoc: p.hasProviderDoc } : {}),
      };
    });

  return renderPlatformPrompt({
    template: plan.rawPrompt,
    context,
    ...(plan.schemaVersion !== undefined ? { schemaVersion: plan.schemaVersion } : {}),
    platformName: "Appstrate",
    timeoutSeconds: plan.timeout,
    availableTools: plan.availableTools,
    availableSkills: plan.availableSkills,
    toolDocs: plan.toolDocs,
    providers: connected,
    ...(plan.schemas.input ? { inputSchema: plan.schemas.input } : {}),
    ...(plan.schemas.config ? { configSchema: plan.schemas.config } : {}),
    ...(plan.schemas.output
      ? { outputSchema: plan.schemas.output as unknown as Record<string, unknown> }
      : {}),
    uploads: plan.files?.map((f) => ({
      name: f.name,
      path: `./documents/${sanitizeStorageKey(f.name)}`,
      size: f.size,
      ...(f.type ? { type: f.type } : {}),
    })),
    runHistoryApi: Boolean(plan.runApi),
  });
}
