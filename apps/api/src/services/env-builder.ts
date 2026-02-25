import type { PromptContext } from "./adapters/types.ts";
import type { LoadedFlow, FlowServiceRequirement } from "../types/index.ts";
import type { FileReference } from "./adapters/types.ts";
import { getProvider } from "@appstrate/connect";
import type { Db } from "@appstrate/connect";
import { db } from "../lib/db.ts";
import { getEnv } from "@appstrate/env";
import { buildServiceTokens } from "./token-resolver.ts";
import { getFlowConfig, getLastExecutionState } from "./state.ts";
import { getFlowPackage } from "./flow-package.ts";
import { getLatestVersionId } from "./flow-versions.ts";

/**
 * Resolve unique provider definitions for prompt context.
 */
export async function resolveProviderDefs(
  database: Db,
  orgId: string,
  services: FlowServiceRequirement[],
): Promise<NonNullable<PromptContext["providers"]>> {
  const providerDefs: NonNullable<PromptContext["providers"]> = [];
  const seen = new Set<string>();
  for (const svc of services) {
    if (seen.has(svc.provider)) continue;
    seen.add(svc.provider);
    const def = await getProvider(database, orgId, svc.provider);
    if (def) {
      providerDefs.push({
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
      });
    }
  }
  return providerDefs;
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
    llmModel: getEnv().LLM_MODEL_ID,
    proxyUrl: params.proxyUrl,
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
}): Promise<{
  promptContext: PromptContext;
  flowPackage: Buffer | null;
  flowVersionId: number | null;
}> {
  const { executionId, flow, serviceProfiles, orgId, userId, input, files } = params;

  const proxyUrl = getEnv().PROXY_URL ?? null;

  const [tokens, config, previousState, providerDefs, flowPackage, flowVersionId] =
    await Promise.all([
      buildServiceTokens(flow.manifest.requires.services, serviceProfiles, orgId),
      getFlowConfig(orgId, flow.id),
      getLastExecutionState(flow.id, userId, orgId),
      resolveProviderDefs(db, orgId, flow.manifest.requires.services),
      getFlowPackage(flow, orgId),
      flow.source === "user" ? getLatestVersionId(flow.id).catch(() => null) : null,
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
    proxyUrl,
  });

  return { promptContext, flowPackage, flowVersionId };
}
