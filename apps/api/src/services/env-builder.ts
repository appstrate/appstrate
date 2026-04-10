// SPDX-License-Identifier: Apache-2.0

import type { PromptContext } from "./adapters/types.ts";
import type { LoadedPackage, AgentProviderRequirement } from "../types/index.ts";
import type { FileReference } from "./adapters/types.ts";
import { getProvider } from "@appstrate/connect";
import { db } from "@appstrate/db/client";
import { getEnv } from "@appstrate/env";
import { signRunToken } from "../lib/run-token.ts";
import { buildProviderTokens } from "./token-resolver.ts";
import { getLastRunState, getPackageMemories } from "./state/index.ts";
import { getPackageConfig } from "./application-packages.ts";
import type { Actor } from "../lib/actor.ts";
import { buildAgentPackage } from "./package-storage.ts";
import { getLatestVersionInfo } from "./package-versions.ts";
import { resolveProxy } from "./org-proxies.ts";
import { resolveModel } from "./org-models.ts";
import { resolveManifestProviders, extractManifestSchemas } from "../lib/manifest-utils.ts";
import type { ProviderProfileMap } from "../types/index.ts";
import { toISO } from "../lib/date-helpers.ts";

export class ModelNotConfiguredError extends Error {
  constructor() {
    super("No LLM model configured for this organization");
    this.name = "ModelNotConfiguredError";
  }
}

/**
 * Build the full run context (tokens, config, state, providers, package, version).
 * Shared by runs.ts and scheduler.ts.
 */
export async function buildRunContext(params: {
  runId: string;
  agent: LoadedPackage;
  providerProfiles: ProviderProfileMap;
  orgId: string;
  applicationId: string;
  actor: Actor | null;
  input?: Record<string, unknown>;
  files?: FileReference[];
  config?: Record<string, unknown>;
  modelId?: string | null;
  proxyId?: string | null;
  overrideVersionLabel?: string;
}): Promise<{
  promptContext: PromptContext;
  agentPackage: Buffer | null;
  versionLabel: string | null;
  versionDirty: boolean;
  proxyLabel: string | null;
  modelLabel: string | null;
  modelSource: string | null;
}> {
  const { runId, agent, providerProfiles, orgId, applicationId, actor, input, files } = params;
  const manifestProviders = resolveManifestProviders(agent.manifest);

  // Skip getPackageConfig when all values are already provided by the caller (from preflight)
  const skipConfigFetch =
    params.config !== undefined && params.modelId !== undefined && params.proxyId !== undefined;

  // Step 1: load all independent data in parallel
  const [
    tokens,
    configFull,
    previousState,
    providerDefs,
    agentPackageResult,
    latestVersion,
    memories,
  ] = await Promise.all([
    buildProviderTokens(manifestProviders, providerProfiles, orgId, applicationId),
    skipConfigFetch ? null : getPackageConfig(applicationId, agent.id),
    getLastRunState(agent.id, actor, orgId, applicationId),
    resolveProviderDefs(orgId, manifestProviders),
    buildAgentPackage(agent, orgId),
    params.overrideVersionLabel
      ? null
      : agent.source !== "system"
        ? getLatestVersionInfo(agent.id).catch(() => null)
        : null,
    getPackageMemories(agent.id, applicationId),
  ]);

  const config = params.config ?? configFull?.config ?? {};
  const agentPackage = agentPackageResult.zip;
  const { toolDocs } = agentPackageResult;

  // Step 2: resolve model and proxy with cascade
  const effectiveModelId = params.modelId ?? configFull?.modelId ?? null;
  const effectiveProxyId = params.proxyId ?? configFull?.proxyId ?? null;

  const [proxyResult, modelResult] = await Promise.all([
    resolveProxy(orgId, agent.id, effectiveProxyId),
    resolveModel(orgId, agent.id, effectiveModelId),
  ]);

  if (!modelResult) {
    throw new ModelNotConfiguredError();
  }

  const proxyUrl = proxyResult?.url ?? null;
  const proxyLabel = proxyResult?.label ?? null;
  const modelLabel = modelResult.label;
  const modelSource = modelResult.isSystemModel ? "system" : "org";
  const llmConfig: PromptContext["llmConfig"] = {
    api: modelResult.api,
    baseUrl: modelResult.baseUrl,
    modelId: modelResult.modelId,
    apiKey: modelResult.apiKey,
    input: modelResult.input,
    contextWindow: modelResult.contextWindow,
    maxTokens: modelResult.maxTokens,
    reasoning: modelResult.reasoning,
    cost: modelResult.cost,
  };

  // Step 3: resolve version label + dirty flag
  let versionLabel: string | null = params.overrideVersionLabel ?? null;
  let versionDirty = false;
  if (!versionLabel && latestVersion) {
    versionLabel = latestVersion.version;
    const updatedAt = agent.updatedAt ?? new Date();
    versionDirty = updatedAt > latestVersion.createdAt;
  }

  // Step 4: assemble prompt context
  const apiEnv = getEnv();
  const runApiUrl =
    apiEnv.PLATFORM_API_URL ??
    (apiEnv.RUN_ADAPTER === "process"
      ? `http://localhost:${apiEnv.PORT}`
      : `http://host.docker.internal:${apiEnv.PORT}`);

  const promptContext: PromptContext = {
    rawPrompt: agent.prompt,
    tokens,
    config,
    previousState,
    runApi: { url: runApiUrl, token: signRunToken(runId) },
    input: input ?? {},
    files,
    schemas: extractManifestSchemas(agent.manifest),
    providers: providerDefs,
    memories: memories.map((m) => ({
      id: m.id,
      content: m.content,
      createdAt: toISO(m.createdAt),
    })),
    llmModel: llmConfig.modelId ?? "unknown",
    llmConfig,
    proxyUrl,
    timeout: (agent.manifest.timeout as number | undefined) ?? 300,
    availableTools: agent.tools.map((e) => ({
      id: e.id,
      name: e.name,
      description: e.description,
    })),
    availableSkills: agent.skills.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
    })),
    toolDocs,
  };

  return {
    promptContext,
    agentPackage,
    versionLabel,
    versionDirty,
    proxyLabel,
    modelLabel,
    modelSource,
  };
}

/** Resolve unique provider definitions for prompt context. */
async function resolveProviderDefs(
  orgId: string,
  providers: AgentProviderRequirement[],
): Promise<NonNullable<PromptContext["providers"]>> {
  const uniqueProviders = [...new Set(providers.map((s) => s.id))];
  const defs = await Promise.all(uniqueProviders.map((p) => getProvider(db, orgId, p)));
  return defs
    .filter((def): def is NonNullable<typeof def> => def != null)
    .filter((def) => def.authMode != null)
    .map((def) => ({
      id: def.id,
      displayName: def.displayName,
      authMode: def.authMode!,
      credentialSchema: def.credentialSchema,
      credentialFieldName: def.credentialFieldName,
      credentialHeaderName: def.credentialHeaderName,
      credentialHeaderPrefix: def.credentialHeaderPrefix,
      authorizedUris: def.authorizedUris,
      allowAllUris: def.allowAllUris,
      docsUrl: def.docsUrl,
      hasProviderDoc: def.hasProviderDoc,
      categories: def.categories,
    }));
}
