// SPDX-License-Identifier: Apache-2.0

import type { AppstrateRunPlan, FileReference } from "./run-launcher/types.ts";
import type { ExecutionContext } from "@appstrate/afps-runtime/types";
import type { LoadedPackage } from "../types/index.ts";
import { signRunToken } from "../lib/run-token.ts";
import {
  CHECKPOINT_KEY,
  getCheckpoint,
  listPinnedSlots,
  scopeFromActor,
} from "./state/package-persistence.ts";
import { getPackageConfig } from "./application-packages.ts";
import type { Actor } from "../lib/actor.ts";
import { buildAgentPackage } from "./package-storage.ts";
import { getLatestVersionInfo } from "./package-versions.ts";
import { resolveProxy } from "./org-proxies.ts";
import { resolveModel } from "./org-models.ts";
import { extractManifestSchemas } from "../lib/manifest-utils.ts";
import { resolveIntegrationSpawns } from "./integration-spawn-resolver.ts";
import type { IntegrationManifestCache } from "./integration-service.ts";
import type { ResolvedConnectionMap } from "@appstrate/core/integration";

export class ModelNotConfiguredError extends Error {
  constructor() {
    super("No LLM model configured for this organization");
    this.name = "ModelNotConfiguredError";
  }
}

/**
 * Raised at kickoff when the resolved model carries no usable secret — an
 * empty/whitespace API key (or OAuth access token). Shipped provider shapes
 * all send the key as a header/query param, so an empty key reaches the
 * upstream as an unauthenticated request: the LLM call 401s and the Pi SDK
 * retries silently, leaving the run stuck in `running` with `error: null`
 * until the 30-min ceiling or a manual cancel (the failure mode this guards).
 *
 * Failing fast here — before the `runs` row is even created — turns that
 * silent hang into a deterministic 400 with a clear code.
 */
export class ModelCredentialMissingError extends Error {
  /** Resolved model label, surfaced in the error detail for operator triage. */
  readonly modelLabel: string;
  constructor(modelLabel: string) {
    super(
      `Model '${modelLabel}' has no API key configured — set a key on its provider credential before running`,
    );
    this.name = "ModelCredentialMissingError";
    this.modelLabel = modelLabel;
  }
}

/**
 * True when a resolved model carries a usable inference secret. Pure +
 * exported for unit testing. An empty or whitespace-only `apiKey` (which is
 * also where a decrypted OAuth access token lands) means the run would hit
 * the provider unauthenticated — treated as "not usable".
 */
export function modelCredentialIsPresent(model: { apiKey: string }): boolean {
  return model.apiKey.trim().length > 0;
}

/**
 * Build the AFPS {@link ExecutionContext} + platform {@link AppstrateRunPlan}
 * for a run. Shared by the run route and the scheduler.
 */
export async function buildRunContext(params: {
  runId: string;
  agent: LoadedPackage;
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
   * Per-run dependency version overrides (#666) — `{ "@scope/name": "draft"
   * | "<spec>" }`. Forwarded into `buildAgentPackage` so a single run can opt
   * a skill out of the published-only resolution (the skill edit loop). Null /
   * omitted resolves the manifest pins verbatim against published versions.
   */
  dependencyOverrides?: Record<string, string> | null;
  /**
   * W3C `traceparent` of the spawning request — forwarded into the
   * runtime so its outbound HTTP traffic becomes child spans of the
   * platform's trace. Optional: callers from background workers
   * (scheduler) leave it unset and the runtime mints a fresh trace.
   */
  traceparent?: string;
  /**
   * Snapshot of the connection resolver output (#199 flat-connections
   * cascade). When set, the spawn loader uses it to pin which connection
   * row is decrypted per (integration, authKey) — admin pins / run
   * overrides survive the kickoff handoff into the live runtime.
   */
  resolvedConnections?: ResolvedConnectionMap | null;
  /**
   * Per-call-graph memo for integration manifest fetches — threaded into the
   * spawn resolver so it reuses the manifests already loaded by the readiness
   * and connection-snapshot passes within the same run trigger.
   */
  manifestCache?: IntegrationManifestCache;
}): Promise<{
  context: ExecutionContext;
  plan: AppstrateRunPlan;
  agentPackage: Buffer | null;
  versionLabel: string | null;
  versionRef: string;
  proxyLabel: string | null;
  modelLabel: string | null;
  modelSource: string | null;
}> {
  const { runId, agent, orgId, applicationId, actor, input, files } = params;

  // Skip getPackageConfig when all values are already provided by the caller (from preflight)
  const skipConfigFetch =
    params.config !== undefined && params.modelId !== undefined && params.proxyId !== undefined;

  // Phase 1.4 — resolve any declared `dependencies.integrations` into
  // ready-to-spawn specs (manifest + bundle bytes + delivery env with
  // live credentials). Kicked off FIRST: its inputs are all available at
  // entry and it is the slowest independent chain (storage fetch +
  // credential decrypt + possible OAuth refresh), so it runs concurrently
  // with the config/checkpoint/bundle and model/proxy resolution below
  // instead of serializing after them. Failures here are per-integration
  // warnings; the run proceeds with the surviving subset. The resolver
  // reads the version from `dependencies.integrations[id]` (§4.1) and the
  // tool/scope selection from `integrations_configuration[id]` (§4.4).
  const integrationSpawnsPromise = resolveIntegrationSpawns({
    orgId,
    applicationId,
    actor,
    agentManifest: agent.manifest as Record<string, unknown>,
    resolvedConnections: params.resolvedConnections ?? null,
    ...(params.manifestCache ? { manifestCache: params.manifestCache } : {}),
  });
  // Guard against an unhandled rejection when a step below throws before
  // the spawn resolution is awaited; the await further down still surfaces
  // the original error.
  integrationSpawnsPromise.catch(() => {});

  // Step 1: load all independent data in parallel
  const persistenceScope = scopeFromActor(actor);
  const [configFull, previousCheckpoint, agentPackageResult, latestVersion, pinnedSlotRows] =
    await Promise.all([
      skipConfigFetch ? null : getPackageConfig(applicationId, agent.id),
      getCheckpoint(agent.id, applicationId, persistenceScope),
      buildAgentPackage(agent, orgId, params.dependencyOverrides ?? null),
      params.overrideVersionLabel
        ? null
        : agent.source !== "system"
          ? getLatestVersionInfo(agent.id).catch(() => null)
          : null,
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

  // Fail-fast on a resolved-but-keyless model. A system stub
  // (`SYSTEM_PROVIDER_KEYS` with an empty `apiKey`) or a credential whose
  // secret decrypted to "" passes the `!modelResult` check above yet would
  // hang the run on an unauthenticated upstream call. Reject at kickoff so
  // the caller gets a clean 400 instead of a run silently stuck in `running`.
  if (!modelCredentialIsPresent(modelResult)) {
    throw new ModelCredentialMissingError(modelResult.label);
  }

  const proxyUrl = proxyResult?.url ?? null;
  const proxyLabel = proxyResult?.label ?? null;
  const modelLabel = modelResult.label;
  const modelSource = modelResult.isSystemModel ? "system" : "org";

  // Step 3: resolve the persisted version display fields.
  let versionLabel: string | null = params.overrideVersionLabel ?? null;
  let versionRef = params.overrideVersionLabel ?? "draft";
  if (!params.overrideVersionLabel && latestVersion) {
    versionLabel = latestVersion.version;
    const updatedAt = agent.updatedAt ?? new Date();
    versionRef = updatedAt > latestVersion.createdAt ? "draft" : latestVersion.version;
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
  const context: ExecutionContext = {
    runId,
    input: input ?? {},
    // No memories enter the prompt; archive memories load via the
    // `recall_memory` tool on demand.
    memories: [],
    ...(previousCheckpoint !== null ? { checkpoint: previousCheckpoint } : {}),
    ...(Object.keys(pinnedSlots).length > 0 ? { pinnedSlots } : {}),
    config,
    ...(params.traceparent ? { traceparent: params.traceparent } : {}),
  };

  // Converge the integration spawn resolution kicked off at entry.
  const integrationSpawns = await integrationSpawnsPromise;

  // AFPS: snake_case. The editor writes `runtime_tools`; reading the wrong key
  // here would silently drop every author's runtime-tool selection.
  const manifestRuntimeTools = (agent.manifest as { runtime_tools?: unknown }).runtime_tools;
  const runtimeTools = Array.isArray(manifestRuntimeTools)
    ? manifestRuntimeTools.filter((t): t is string => typeof t === "string")
    : undefined;

  const plan: AppstrateRunPlan = {
    bundle,
    rawPrompt: agent.prompt,
    outputSchema: extractManifestSchemas(agent.manifest).output,
    ...(runtimeTools && runtimeTools.length > 0 ? { runtimeTools } : {}),
    llmConfig: modelResult,
    runToken: signRunToken(runId),
    proxyUrl,
    timeout: (agent.manifest.timeout as number | undefined) ?? 300,
    files,
    ...(integrationSpawns.length > 0 ? { integrations: integrationSpawns } : {}),
  };

  return {
    context,
    plan,
    agentPackage,
    versionLabel,
    versionRef,
    proxyLabel,
    modelLabel,
    modelSource,
  };
}
