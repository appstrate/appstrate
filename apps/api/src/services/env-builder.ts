import type { PromptContext } from "./adapters/types.ts";
import type { LoadedPackage, FlowProviderRequirement } from "../types/index.ts";
import type { FileReference } from "./adapters/types.ts";
import { getProvider } from "@appstrate/connect";
import type { Db } from "@appstrate/db/client";
import { db } from "../lib/db.ts";
import { getEnv } from "@appstrate/env";
import { signExecutionToken } from "../lib/execution-token.ts";
import { buildProviderTokens } from "./token-resolver.ts";
import {
  getPackageConfig,
  getFlowOverrides,
  getLastExecutionState,
  getPackageMemories,
} from "./state/index.ts";
import type { Actor } from "../lib/actor.ts";
import { buildFlowPackage } from "./package-storage.ts";
import { getLatestVersionWithManifest } from "./package-versions.ts";
import { resolveProxy } from "./org-proxies.ts";
import { resolveModel } from "./org-models.ts";
import { resolveManifestProviders } from "../lib/manifest-utils.ts";
import { resolveProviderProfiles } from "./connection-profiles.ts";
import { validateFlowReadiness } from "./flow-readiness.ts";

export class ModelNotConfiguredError extends Error {
  constructor() {
    super("No LLM model configured for this organization");
    this.name = "ModelNotConfiguredError";
  }
}

/**
 * Resolve provider profiles, config, and validate flow readiness.
 * Shared preflight logic for all execution paths (manual run, scheduled, share link).
 */
export async function resolvePreflightContext(params: {
  flow: LoadedPackage;
  actor: Actor;
  packageId: string;
  orgId: string;
  profileIdOverride?: string;
}): Promise<{ providerProfiles: Record<string, string>; config: Record<string, unknown> }> {
  const { flow, actor, packageId, orgId, profileIdOverride } = params;
  const manifestProviders = resolveManifestProviders(flow.manifest);

  const [providerProfiles, config] = await Promise.all([
    resolveProviderProfiles(manifestProviders, actor, packageId, orgId, profileIdOverride),
    getPackageConfig(orgId, packageId),
  ]);

  await validateFlowReadiness({ flow, providerProfiles, orgId, config });

  return { providerProfiles, config };
}

/**
 * Resolve unique provider definitions for prompt context.
 */
export async function resolveProviderDefs(
  database: Db,
  orgId: string,
  providers: FlowProviderRequirement[],
): Promise<NonNullable<PromptContext["providers"]>> {
  const uniqueProviders = [...new Set(providers.map((s) => s.provider))];
  const defs = await Promise.all(uniqueProviders.map((p) => getProvider(database, orgId, p)));
  return defs
    .filter((def): def is NonNullable<typeof def> => def != null)
    .map((def) => ({
      id: def.id,
      displayName: def.displayName,
      authMode: def.authMode,
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
export function buildExecutionApi(executionId: string): { url: string; token: string } {
  const apiEnv = getEnv();
  const url = apiEnv.PLATFORM_API_URL ?? `http://host.docker.internal:${apiEnv.PORT}`;
  return { url, token: signExecutionToken(executionId) };
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
      input: params.flow.manifest.input?.schema,
      config: params.flow.manifest.config?.schema,
      output: params.flow.manifest.output?.schema,
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
 * Build the full execution context (tokens, config, state, providers, package, version).
 * Shared by executions.ts, share.ts, and scheduler.ts.
 */
export async function buildExecutionContext(params: {
  executionId: string;
  flow: LoadedPackage;
  providerProfiles: Record<string, string>;
  orgId: string;
  actor: Actor;
  input?: Record<string, unknown>;
  files?: FileReference[];
  config?: Record<string, unknown>;
  modelId?: string | null;
  proxyId?: string | null;
  overrideVersionId?: number;
}): Promise<{
  promptContext: PromptContext;
  flowPackage: Buffer | null;
  packageVersionId: number | null;
  proxyLabel: string | null;
  modelLabel: string | null;
}> {
  const { executionId, flow, providerProfiles, orgId, actor, input, files } = params;

  const manifestProviders = resolveManifestProviders(flow.manifest);

  // Step 1: load config, flow overrides, and independent data in parallel
  const [
    tokens,
    config,
    flowOverrides,
    previousState,
    providerDefs,
    flowPackageResult,
    latestVersion,
    memories,
  ] = await Promise.all([
    buildProviderTokens(manifestProviders, providerProfiles, orgId),
    params.config ?? getPackageConfig(orgId, flow.id),
    getFlowOverrides(orgId, flow.id),
    getLastExecutionState(flow.id, actor, orgId),
    resolveProviderDefs(db, orgId, manifestProviders),
    buildFlowPackage(flow, orgId),
    params.overrideVersionId
      ? Promise.resolve(params.overrideVersionId)
      : flow.source !== "system"
        ? getLatestVersionWithManifest(flow.id).catch(() => null)
        : null,
    getPackageMemories(flow.id, orgId),
  ]);

  const flowPackage = flowPackageResult.zip;
  const { toolDocs } = flowPackageResult;

  // Step 2: resolve model and proxy with cascade (request override → flow column → org/system default)
  const effectiveModelId = params.modelId ?? flowOverrides.modelId;
  const effectiveProxyId = params.proxyId ?? flowOverrides.proxyId;

  const [proxyResult, modelResult] = await Promise.all([
    resolveProxy(orgId, flow.id, effectiveProxyId),
    resolveModel(orgId, flow.id, effectiveModelId),
  ]);

  if (!modelResult) {
    throw new ModelNotConfiguredError();
  }

  // Resolve version ID: explicit override is trusted; otherwise only associate
  // the latest version if its manifest matches the live flow (dirty check).
  let packageVersionId: number | null;
  if (typeof latestVersion === "number") {
    // overrideVersionId path — already a plain number
    packageVersionId = latestVersion;
  } else if (latestVersion) {
    // Compare version manifest with live flow manifest
    const liveKey = JSON.stringify(flow.manifest);
    const versionKey = JSON.stringify(latestVersion.manifest);
    packageVersionId = liveKey === versionKey ? latestVersion.id : null;
  } else {
    packageVersionId = null;
  }

  const proxyUrl = proxyResult?.url ?? null;
  const proxyLabel = proxyResult?.label ?? null;
  const modelLabel = modelResult.label ?? null;
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

  const promptContext = buildPromptContext({
    flow,
    tokens,
    config,
    previousState,
    executionApi: buildExecutionApi(executionId),
    input,
    files,
    providers: providerDefs,
    memories: memories.map((m) => ({
      id: m.id,
      content: m.content,
      createdAt: m.createdAt?.toISOString() ?? null,
    })),
    toolDocs,
    proxyUrl,
    llmConfig,
  });

  return { promptContext, flowPackage, packageVersionId, proxyLabel, modelLabel };
}
