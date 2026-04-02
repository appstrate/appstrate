// SPDX-License-Identifier: Apache-2.0

import type { PromptContext } from "./adapters/types.ts";
import type { LoadedPackage, AgentProviderRequirement } from "../types/index.ts";
import type { FileReference } from "./adapters/types.ts";
import { getProvider } from "@appstrate/connect";
import type { Db } from "@appstrate/db/client";
import { db } from "@appstrate/db/client";
import { getEnv } from "@appstrate/env";
import { signRunToken } from "../lib/run-token.ts";
import { buildProviderTokens } from "./token-resolver.ts";
import { getPackageConfig, getLastRunState, getPackageMemories } from "./state/index.ts";
import type { Actor } from "../lib/actor.ts";
import { buildAgentPackage } from "./package-storage.ts";
import { getLatestVersionWithManifest } from "./package-versions.ts";
import { resolveProxy } from "./org-proxies.ts";
import { resolveModel } from "./org-models.ts";
import { asJSONSchemaObject } from "@appstrate/core/form";
import { resolveManifestProviders } from "../lib/manifest-utils.ts";
import type { ProviderProfileMap } from "../types/index.ts";
import { toISO } from "../lib/date-helpers.ts";

export class ModelNotConfiguredError extends Error {
  constructor() {
    super("No LLM model configured for this organization");
    this.name = "ModelNotConfiguredError";
  }
}

/**
 * Resolve unique provider definitions for prompt context.
 */
export async function resolveProviderDefs(
  database: Db,
  orgId: string,
  providers: AgentProviderRequirement[],
): Promise<NonNullable<PromptContext["providers"]>> {
  const uniqueProviders = [...new Set(providers.map((s) => s.id))];
  const defs = await Promise.all(uniqueProviders.map((p) => getProvider(database, orgId, p)));
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

/**
 * Build the execution API descriptor for container-to-host calls.
 * Token is HMAC-signed to prevent forgery from leaked executionIds.
 */
export function buildRunApi(runId: string): { url: string; token: string } {
  const apiEnv = getEnv();
  const url = apiEnv.PLATFORM_API_URL ?? `http://host.docker.internal:${apiEnv.PORT}`;
  return { url, token: signRunToken(runId) };
}

/**
 * Builds a structured PromptContext from flow data.
 */
export function buildPromptContext(params: {
  flow: LoadedPackage;
  tokens: Record<string, string>;
  config: Record<string, unknown>;
  previousState: Record<string, unknown> | null;
  executionApi?: { url: string; token: string };
  input?: Record<string, unknown>;
  files?: FileReference[];
  providers?: PromptContext["providers"];
  memories?: PromptContext["memories"];
  toolDocs?: PromptContext["toolDocs"];
  proxyUrl?: string | null;
  llmConfig: PromptContext["llmConfig"];
}): PromptContext {
  return {
    rawPrompt: params.flow.prompt,
    tokens: params.tokens,
    config: params.config,
    previousState: params.previousState,
    executionApi: params.executionApi,
    input: params.input ?? {},
    files: params.files,
    schemas: {
      input: params.flow.manifest.input?.schema
        ? asJSONSchemaObject(params.flow.manifest.input.schema)
        : undefined,
      config: params.flow.manifest.config?.schema
        ? asJSONSchemaObject(params.flow.manifest.config.schema)
        : undefined,
      output: params.flow.manifest.output?.schema
        ? asJSONSchemaObject(params.flow.manifest.output.schema)
        : undefined,
    },
    providers: params.providers ?? [],
    memories: params.memories,
    llmModel: params.llmConfig?.modelId ?? "unknown",
    llmConfig: params.llmConfig,
    proxyUrl: params.proxyUrl,
    timeout: (params.flow.manifest.timeout as number | undefined) ?? 300,
    availableTools: params.flow.tools.map((e) => ({
      id: e.id,
      name: e.name,
      description: e.description,
    })),
    availableSkills: params.flow.skills.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
    })),
    toolDocs: params.toolDocs,
  };
}

/**
 * Load all independent execution data in parallel: tokens, config, state,
 * provider definitions, flow package, latest version, and memories.
 */
async function loadExecutionData(params: {
  flow: LoadedPackage;
  providerProfiles: ProviderProfileMap;
  orgId: string;
  actor: Actor | null;
  manifestProviders: AgentProviderRequirement[];
  skipConfigFetch: boolean;
  overrideVersionId?: number;
}) {
  const { flow, providerProfiles, orgId, actor, manifestProviders, skipConfigFetch } = params;

  const [
    tokens,
    configFull,
    previousState,
    providerDefs,
    agentPackageResult,
    latestVersion,
    memories,
  ] = await Promise.all([
    buildProviderTokens(manifestProviders, providerProfiles, orgId),
    skipConfigFetch ? null : getPackageConfig(orgId, flow.id),
    getLastRunState(flow.id, actor, orgId),
    resolveProviderDefs(db, orgId, manifestProviders),
    buildAgentPackage(flow, orgId),
    params.overrideVersionId
      ? Promise.resolve(params.overrideVersionId)
      : flow.source !== "system"
        ? getLatestVersionWithManifest(flow.id).catch(() => null)
        : null,
    getPackageMemories(flow.id, orgId),
  ]);

  return {
    tokens,
    configFull,
    previousState,
    providerDefs,
    agentPackageResult,
    latestVersion,
    memories,
  };
}

/**
 * Resolve model and proxy with cascade logic:
 * request override → flow column → org/system default.
 * Throws ModelNotConfiguredError if no model is found.
 */
async function resolveModelAndProxy(params: {
  orgId: string;
  flowId: string;
  effectiveModelId: string | null;
  effectiveProxyId: string | null;
}) {
  const { orgId, flowId, effectiveModelId, effectiveProxyId } = params;

  const [proxyResult, modelResult] = await Promise.all([
    resolveProxy(orgId, flowId, effectiveProxyId),
    resolveModel(orgId, flowId, effectiveModelId),
  ]);

  if (!modelResult) {
    throw new ModelNotConfiguredError();
  }

  const proxyUrl = proxyResult?.url ?? null;
  const proxyLabel = proxyResult?.label ?? null;
  const modelLabel = modelResult.label;
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

  return { proxyUrl, proxyLabel, modelLabel, llmConfig };
}

/**
 * Resolve the package version ID from the latest version result.
 * Explicit override is trusted; otherwise only associate the latest version
 * if its manifest matches the live flow (dirty check).
 */
function resolvePackageVersionId(
  latestVersion: number | { id: number; manifest: Record<string, unknown> } | null,
  flowManifest: Record<string, unknown>,
): number | null {
  if (typeof latestVersion === "number") {
    return latestVersion;
  }
  if (latestVersion) {
    const liveKey = JSON.stringify(flowManifest);
    const versionKey = JSON.stringify(latestVersion.manifest);
    return liveKey === versionKey ? latestVersion.id : null;
  }
  return null;
}

/**
 * Build the full execution context (tokens, config, state, providers, package, version).
 * Shared by executions.ts and scheduler.ts.
 */
export async function buildExecutionContext(params: {
  executionId: string;
  flow: LoadedPackage;
  providerProfiles: ProviderProfileMap;
  orgId: string;
  actor: Actor | null;
  input?: Record<string, unknown>;
  files?: FileReference[];
  config?: Record<string, unknown>;
  modelId?: string | null;
  proxyId?: string | null;
  overrideVersionId?: number;
}): Promise<{
  promptContext: PromptContext;
  agentPackage: Buffer | null;
  packageVersionId: number | null;
  proxyLabel: string | null;
  modelLabel: string | null;
}> {
  const { executionId, flow, providerProfiles, orgId, actor, input, files } = params;
  const manifestProviders = resolveManifestProviders(flow.manifest);

  // Skip getPackageConfig when all values are already provided by the caller (from preflight)
  const skipConfigFetch =
    params.config !== undefined && params.modelId !== undefined && params.proxyId !== undefined;

  // Step 1: load all independent data in parallel
  const {
    tokens,
    configFull,
    previousState,
    providerDefs,
    agentPackageResult,
    latestVersion,
    memories,
  } = await loadExecutionData({
    flow,
    providerProfiles,
    orgId,
    actor,
    manifestProviders,
    skipConfigFetch,
    overrideVersionId: params.overrideVersionId,
  });

  const config = params.config ?? configFull?.config ?? {};
  const agentPackage = agentPackageResult.zip;
  const { toolDocs } = agentPackageResult;

  // Step 2: resolve model and proxy with cascade
  const effectiveModelId = params.modelId ?? configFull?.modelId ?? null;
  const effectiveProxyId = params.proxyId ?? configFull?.proxyId ?? null;

  const { proxyUrl, proxyLabel, modelLabel, llmConfig } = await resolveModelAndProxy({
    orgId,
    flowId: flow.id,
    effectiveModelId,
    effectiveProxyId,
  });

  // Step 3: resolve version ID
  const packageVersionId = resolvePackageVersionId(latestVersion, flow.manifest);

  // Step 4: assemble prompt context
  const promptContext = buildPromptContext({
    flow,
    tokens,
    config,
    previousState,
    executionApi: buildRunApi(executionId),
    input,
    files,
    providers: providerDefs,
    memories: memories.map((m) => ({
      id: m.id,
      content: m.content,
      createdAt: toISO(m.createdAt),
    })),
    toolDocs,
    proxyUrl,
    llmConfig,
  });

  return { promptContext, agentPackage, packageVersionId, proxyLabel, modelLabel };
}
