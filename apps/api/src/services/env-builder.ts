// SPDX-License-Identifier: Apache-2.0

import type {
  AppstrateRunPlan,
  FileReference,
  LlmConfig,
  ProviderSummary,
} from "./adapters/types.ts";
import type { ExecutionContext } from "@appstrate/afps-runtime/types";
import type { LoadedPackage, AgentProviderRequirement } from "../types/index.ts";
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

export class ModelNotConfiguredError extends Error {
  constructor() {
    super("No LLM model configured for this organization");
    this.name = "ModelNotConfiguredError";
  }
}

/**
 * Normalise a DB `createdAt` (Date | ISO string | null) into epoch ms — the
 * representation `ExecutionContext.memories[].createdAt` requires.
 */
function toEpochMs(value: Date | string | null | undefined): number {
  if (!value) return 0;
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Build the AFPS {@link ExecutionContext} + platform {@link AppstrateRunPlan}
 * for a run. Shared by the run route and the scheduler.
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
  context: ExecutionContext;
  plan: AppstrateRunPlan;
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
    getLastRunState({ orgId, applicationId }, agent.id, actor),
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
  const llmConfig: LlmConfig = {
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

  // Step 4: assemble AFPS execution context + platform plan
  const apiEnv = getEnv();
  const runApiUrl =
    apiEnv.PLATFORM_API_URL ??
    (apiEnv.RUN_ADAPTER === "process"
      ? `http://localhost:${apiEnv.PORT}`
      : `http://host.docker.internal:${apiEnv.PORT}`);

  const context: ExecutionContext = {
    runId,
    input: input ?? {},
    memories: memories.map((m) => ({
      content: m.content,
      createdAt: toEpochMs(m.createdAt),
    })),
    ...(previousState !== null ? { state: previousState } : {}),
    config,
  };

  const plan: AppstrateRunPlan = {
    rawPrompt: agent.prompt,
    schemaVersion: (agent.manifest.schemaVersion as string | undefined) ?? "1.0",
    schemas: extractManifestSchemas(agent.manifest),
    llmConfig,
    runApi: { url: runApiUrl, token: signRunToken(runId) },
    proxyUrl,
    timeout: (agent.manifest.timeout as number | undefined) ?? 300,
    tokens,
    providers: providerDefs,
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
    files,
  };

  return {
    context,
    plan,
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
): Promise<ProviderSummary[]> {
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
