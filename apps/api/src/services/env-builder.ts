// SPDX-License-Identifier: Apache-2.0

import type {
  AppstrateRunPlan,
  FileReference,
  LlmConfig,
  ProviderSummary,
} from "./run-launcher/types.ts";
import type { ExecutionContext } from "@appstrate/afps-runtime/types";
import type { LoadedPackage, AgentProviderRequirement } from "../types/index.ts";
import { getProvider } from "@appstrate/connect";
import { db } from "@appstrate/db/client";
import { getEnv } from "@appstrate/env";
import { signRunToken } from "../lib/run-token.ts";
import { buildProviderTokens } from "./token-resolver.ts";
import {
  CHECKPOINT_KEY,
  getCheckpoint,
  listPinnedMemories,
  listPinnedSlots,
  scopeFromActor,
} from "./state/package-persistence.ts";
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
  /**
   * W3C `traceparent` of the spawning request — forwarded into the
   * runtime so its outbound HTTP traffic becomes child spans of the
   * platform's trace. Optional: callers from background workers
   * (scheduler) leave it unset and the runtime mints a fresh trace.
   */
  traceparent?: string;
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
  const persistenceScope = scopeFromActor(actor);
  const [
    tokens,
    configFull,
    previousCheckpoint,
    providerDefs,
    agentPackageResult,
    latestVersion,
    memories,
    pinnedSlotRows,
  ] = await Promise.all([
    buildProviderTokens(manifestProviders, providerProfiles, orgId, applicationId),
    skipConfigFetch ? null : getPackageConfig(applicationId, agent.id),
    getCheckpoint(agent.id, applicationId, persistenceScope),
    resolveProviderDefs(orgId, manifestProviders),
    buildAgentPackage(agent, orgId),
    params.overrideVersionLabel
      ? null
      : agent.source !== "system"
        ? getLatestVersionInfo(agent.id).catch(() => null)
        : null,
    // Only pinned memories enter the prompt; archive memories load via the
    // `recall_memory` tool on demand. See ADR-012.
    listPinnedMemories(agent.id, applicationId, persistenceScope),
    // Named pinned slots (any non-null key, EXCEPT "checkpoint" which is
    // already loaded above as `previousCheckpoint`). Renders in the prompt's
    // `## Pinned Slots` section so cross-run state under custom keys is
    // visible to the agent. Honors the documented contract: `pin({key, ...})`
    // with any key produces a slot rendered in this prompt on every run.
    listPinnedSlots(agent.id, applicationId, persistenceScope),
  ]);

  const config = params.config ?? configFull?.config ?? {};
  const agentPackage = agentPackageResult.zip;
  const { bundle } = agentPackageResult;

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
    apiShape: modelResult.apiShape,
    baseUrl: modelResult.baseUrl,
    modelId: modelResult.modelId,
    apiKey: modelResult.apiKey,
    input: modelResult.input,
    contextWindow: modelResult.contextWindow,
    maxTokens: modelResult.maxTokens,
    reasoning: modelResult.reasoning,
    cost: modelResult.cost,
    ...(modelResult.providerId ? { providerId: modelResult.providerId } : {}),
    ...(modelResult.credentialId ? { credentialId: modelResult.credentialId } : {}),
    ...(modelResult.rewriteUrlPath ? { rewriteUrlPath: modelResult.rewriteUrlPath } : {}),
    ...(modelResult.forceStream !== undefined ? { forceStream: modelResult.forceStream } : {}),
    ...(modelResult.forceStore !== undefined ? { forceStore: modelResult.forceStore } : {}),
  };

  // Step 3: resolve version label + dirty flag
  let versionLabel: string | null = params.overrideVersionLabel ?? null;
  let versionDirty = false;
  if (!versionLabel && latestVersion) {
    versionLabel = latestVersion.version;
    const updatedAt = agent.updatedAt ?? new Date();
    versionDirty = updatedAt > latestVersion.createdAt;
  }

  // Collapse pinned slot rows to a key→content map. We exclude `checkpoint`
  // (already surfaced as `context.checkpoint` and rendered as `## Checkpoint`)
  // and rely on the desc-by-updatedAt order from `listPinnedSlots` for
  // last-write-wins: when both an actor-specific and a shared row exist for
  // the same key, the most recently written one is kept regardless of scope.
  // Visibility itself is already enforced upstream by `buildVisibilityFilter`
  // (the caller's scope determines which rows are eligible).
  const pinnedSlots: Record<string, unknown> = {};
  for (const row of pinnedSlotRows) {
    if (row.key === CHECKPOINT_KEY) continue;
    if (!(row.key in pinnedSlots)) pinnedSlots[row.key] = row.content;
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
      // Memory content is JSONB at the storage layer (post-unification).
      // The AFPS runtime contract requires a string — stringify structured
      // entries; pass strings through verbatim.
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      createdAt: toEpochMs(m.createdAt),
    })),
    ...(previousCheckpoint !== null ? { checkpoint: previousCheckpoint } : {}),
    ...(Object.keys(pinnedSlots).length > 0 ? { pinnedSlots } : {}),
    config,
    ...(params.traceparent ? { traceparent: params.traceparent } : {}),
  };

  const plan: AppstrateRunPlan = {
    bundle,
    rawPrompt: agent.prompt,
    outputSchema: extractManifestSchemas(agent.manifest).output,
    llmConfig,
    runApi: { url: runApiUrl, token: signRunToken(runId) },
    proxyUrl,
    timeout: (agent.manifest.timeout as number | undefined) ?? 300,
    tokens,
    providers: providerDefs,
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
      categories: def.categories,
    }));
}
