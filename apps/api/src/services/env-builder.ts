import type { PromptContext } from "./adapters/types.ts";
import type { LoadedFlow, FlowServiceRequirement } from "../types/index.ts";
import type { FileReference } from "./adapters/types.ts";
import { getProvider } from "@appstrate/connect";
import type { Db } from "@appstrate/db/client";
import { db } from "../lib/db.ts";
import { getEnv } from "@appstrate/env";
import { buildServiceTokens } from "./token-resolver.ts";
import { getPackageConfig, getLastExecutionState, getPackageMemories } from "./state.ts";
import { getPackageZip } from "./package-storage.ts";
import { getLatestVersionId } from "./package-versions.ts";
import { resolveProxyUrl } from "./org-proxies.ts";

/**
 * Resolve unique provider definitions for prompt context.
 */
export async function resolveProviderDefs(
  database: Db,
  orgId: string,
  services: FlowServiceRequirement[],
): Promise<NonNullable<PromptContext["providers"]>> {
  const uniqueProviders = [...new Set(services.map((s) => s.provider))];
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
      categories: def.categories,
    }));
}

/**
 * Build the execution API descriptor for container-to-host calls.
 */
export function buildExecutionApi(executionId: string): { url: string; token: string } {
  const apiEnv = getEnv();
  const url = apiEnv.PLATFORM_API_URL ?? `http://host.docker.internal:${apiEnv.PORT}`;
  return { url, token: executionId };
}

/**
 * Builds a structured PromptContext from flow data.
 */
export function buildPromptContext(params: {
  flow: LoadedFlow;
  tokens: Record<string, string>;
  config: Record<string, unknown>;
  previousState: Record<string, unknown> | null;
  executionApi?: { url: string; token: string };
  input?: Record<string, unknown>;
  files?: FileReference[];
  providers?: PromptContext["providers"];
  memories?: PromptContext["memories"];
  proxyUrl?: string | null;
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
    services: params.flow.manifest.requires.services.map((s) => ({
      id: s.id,
      provider: s.provider,
    })),
    providers: params.providers,
    memories: params.memories,
    llmModel: getEnv().LLM_MODEL_ID,
    proxyUrl: params.proxyUrl,
    timeout: params.flow.manifest.execution?.timeout ?? 300,
    availableTools: params.flow.extensions.map((e) => ({
      id: e.id,
      name: e.name,
      description: e.description,
    })),
    availableSkills: params.flow.skills.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
    })),
  };
}

/**
 * Build the full execution context (tokens, config, state, providers, package, version).
 * Shared by executions.ts, share.ts, and scheduler.ts.
 */
export async function buildExecutionContext(params: {
  executionId: string;
  flow: LoadedFlow;
  serviceProfiles: Record<string, string>;
  orgId: string;
  userId: string;
  input?: Record<string, unknown>;
  files?: FileReference[];
  config?: Record<string, unknown>;
  overrideVersionId?: number;
}): Promise<{
  promptContext: PromptContext;
  flowPackage: Buffer | null;
  flowVersionId: number | null;
}> {
  const { executionId, flow, serviceProfiles, orgId, userId, input, files } = params;

  const [
    tokens,
    config,
    previousState,
    providerDefs,
    flowPackage,
    flowVersionId,
    proxyUrl,
    memories,
  ] = await Promise.all([
    buildServiceTokens(flow.manifest.requires.services, serviceProfiles, orgId),
    params.config ?? getPackageConfig(orgId, flow.id),
    getLastExecutionState(flow.id, userId, orgId),
    resolveProviderDefs(db, orgId, flow.manifest.requires.services),
    getPackageZip(flow, orgId),
    params.overrideVersionId
      ? Promise.resolve(params.overrideVersionId)
      : flow.source !== "built-in"
        ? getLatestVersionId(flow.id).catch(() => null)
        : null,
    resolveProxyUrl(orgId, flow.id, params.config),
    getPackageMemories(flow.id, orgId),
  ]);

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
    proxyUrl,
  });

  return { promptContext, flowPackage, flowVersionId };
}
