// SPDX-License-Identifier: Apache-2.0

/**
 * Shared preflight for inline-run endpoints.
 *
 * Runs every validation that has no durable side effect:
 *   1. Manifest shape (AFPS + inline caps)
 *   2. providerProfiles body shape
 *   3. config + input against the manifest's own AJV schemas
 *   4. Provider profile resolution (reads DB, no writes)
 *   5. Agent readiness (prompt, skills, tools, provider deps, config)
 *
 * Used by:
 *   - POST /api/runs/inline — calls this, then inserts the shadow row and
 *     fires the pipeline. Running it first means invalid manifests no longer
 *     leave orphan shadow rows.
 *   - POST /api/runs/inline/validate — calls this, returns 200 on success.
 *
 * Throws `ApiError` on any failure (same shape the routes already emit).
 */
import { z } from "zod";
import type { Actor } from "../lib/actor.ts";
import type { AgentManifest, ProviderProfileMap } from "../types/index.ts";
import { ApiError, invalidRequest } from "../lib/errors.ts";
import { asJSONSchemaObject } from "@appstrate/core/form";
import { validateConfig, validateInput } from "./schema.ts";
import { validateInlineManifest } from "./inline-manifest-validation.ts";
import { buildShadowLoadedPackage, generateShadowPackageId } from "./inline-run.ts";
import { getInlineRunLimits } from "./run-limits.ts";
import { resolveManifestProviders } from "../lib/manifest-utils.ts";
import { validateAgentReadiness } from "./agent-readiness.ts";
import { resolveActorProfileContext, resolveProviderProfiles } from "./connection-profiles.ts";

export interface InlineRunBody {
  manifest?: unknown;
  prompt?: unknown;
  input?: Record<string, unknown>;
  config?: Record<string, unknown>;
  providerProfiles?: Record<string, string>;
  modelId?: string | null;
  proxyId?: string | null;
}

export interface InlineRunPreflightResult {
  manifest: AgentManifest;
  prompt: string;
  effectiveConfig: Record<string, unknown>;
  effectiveInput: Record<string, unknown> | null;
  providerProfiles: ProviderProfileMap;
  providerProfilesOverride: Record<string, string> | undefined;
  modelIdOverride: string | null;
  proxyIdOverride: string | null;
}

const providerProfilesSchema = z.record(z.string(), z.uuid()).optional();

export async function runInlinePreflight(params: {
  orgId: string;
  applicationId: string;
  actor: Actor | null;
  body: InlineRunBody;
}): Promise<InlineRunPreflightResult> {
  const { orgId, applicationId, actor, body } = params;

  // ----- 1. Manifest shape -----
  const validated = validateInlineManifest({
    manifest: body.manifest,
    prompt: body.prompt,
    limits: getInlineRunLimits(),
  });
  if (!validated.valid) {
    throw new ApiError({
      status: 400,
      code: "invalid_inline_manifest",
      title: "Invalid Inline Manifest",
      detail: validated.errors.join("; "),
    });
  }
  const manifest = validated.manifest as AgentManifest;
  const prompt = body.prompt as string;

  // ----- 2. Body-field validation -----
  const providerProfilesOverride = providerProfilesSchema.safeParse(body.providerProfiles);
  if (!providerProfilesOverride.success) {
    throw invalidRequest("providerProfiles must map providerId → profileUUID", "providerProfiles");
  }
  const modelIdOverride = body.modelId ?? null;
  const proxyIdOverride = body.proxyId ?? null;

  // ----- 3. config + input against manifest schemas (AJV) -----
  const configSchema = manifest.config?.schema;
  const effectiveConfig =
    body.config && typeof body.config === "object" && !Array.isArray(body.config)
      ? (body.config as Record<string, unknown>)
      : {};
  if (configSchema) {
    const cv = validateConfig(effectiveConfig, asJSONSchemaObject(configSchema));
    if (!cv.valid) {
      throw invalidRequest(`config: ${cv.errors?.[0]?.message ?? "invalid"}`, "config");
    }
  }

  const inputSchema = manifest.input?.schema;
  const effectiveInput =
    body.input && typeof body.input === "object" && !Array.isArray(body.input)
      ? (body.input as Record<string, unknown>)
      : null;
  if (inputSchema) {
    const iv = validateInput(effectiveInput ?? undefined, asJSONSchemaObject(inputSchema));
    if (!iv.valid) {
      throw invalidRequest(`input: ${iv.errors?.[0]?.message ?? "invalid"}`, "input");
    }
  }

  // ----- 4. Provider profile resolution + readiness -----
  // Internal-only shadow (throwaway id, never persisted): we need a
  // LoadedPackage shape to call resolveActorProfileContext +
  // validateAgentReadiness, but nothing below leaks this id back to the
  // caller — they build the real LoadedPackage from the inserted shadowId.
  // `resolveActorProfileContext` looks up per-agent overrides by id and
  // will simply miss (no such package exists yet) — intended for preflight.
  const probeAgent = buildShadowLoadedPackage(generateShadowPackageId(), manifest, prompt);

  const { defaultUserProfileId } = await resolveActorProfileContext(actor, probeAgent.id);
  const providerProfiles = await resolveProviderProfiles(
    resolveManifestProviders(manifest),
    defaultUserProfileId,
    providerProfilesOverride.data,
    null,
    applicationId,
  );
  await validateAgentReadiness({
    agent: probeAgent,
    providerProfiles,
    orgId,
    config: effectiveConfig,
    applicationId,
  });

  return {
    manifest,
    prompt,
    effectiveConfig,
    effectiveInput,
    providerProfiles,
    providerProfilesOverride: providerProfilesOverride.data,
    modelIdOverride,
    proxyIdOverride,
  };
}
