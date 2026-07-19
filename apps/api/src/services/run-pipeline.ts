// SPDX-License-Identifier: Apache-2.0

/**
 * Shared run pipeline — the common tail of "build context → pre-run hooks → create run → execute".
 * Used by both the POST /run route and the scheduler's triggerScheduledRun.
 */

import { logger } from "../lib/logger.ts";
import {
  buildRunContext,
  ModelNotConfiguredError,
  ModelCredentialMissingError,
} from "./run-context-builder.ts";
import { toBundleApiError } from "./run-launcher/bundle-error-mapping.ts";
import { toBrowserCapabilityApiError } from "./browser-capability-error-mapping.ts";
import { createRun, appendRunLog } from "./state/runs.ts";
import { getPackageConfig } from "./application-packages.ts";
import { executeAgentInBackground } from "./run-launcher/execute-background.ts";
import { validateAgentReadiness } from "./agent-readiness.ts";
import { resolveRunConnectionsOrError } from "./integration-connection-resolver.ts";
import {
  resolveRunIntegrationVersions,
  type IntegrationManifestCache,
  type ResolvedIntegrationVersionMap,
} from "./integration-service.ts";
import { collectOverridableDependencyIds } from "@appstrate/core/dependencies";
import type { ConnectionOverrides, ResolvedConnectionMap } from "@appstrate/core/integration";
import { parseScopedName } from "@appstrate/core/naming";
import { mintSinkCredentials } from "../lib/mint-sink-credentials.ts";
import { encrypt } from "@appstrate/connect";
import { getEnv } from "@appstrate/env";
import { getOrchestrator } from "./orchestrator/index.ts";
import { ApiError } from "../lib/errors.ts";
import type { LoadedPackage } from "../types/index.ts";
import type { Actor } from "../lib/actor.ts";
import type { FileReference } from "./run-launcher/types.ts";
import { runPreflightGates } from "./run-preflight-gates.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import { runWithSpan } from "@appstrate/core/telemetry";

/**
 * Extract the denormalized @scope and display-name snapshot for a loaded
 * package. Stored on `runs.agent_scope` / `runs.agent_name` so the global
 * /runs view survives rename, delete, and inline-run compaction (after
 * which the manifest is NULLed).
 */
export function extractRunAgentDenorm(pkg: LoadedPackage): {
  scope: string | null;
  name: string | null;
} {
  const parsed = parseScopedName(pkg.id);
  const manifestName =
    typeof pkg.manifest.display_name === "string"
      ? pkg.manifest.display_name
      : typeof pkg.manifest.name === "string"
        ? pkg.manifest.name
        : null;
  return {
    scope: parsed?.scope ?? null,
    name: manifestName,
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunPipelineParams {
  runId: string;
  agent: LoadedPackage;
  orgId: string;
  actor: Actor | null;
  input?: Record<string, unknown> | null;
  files?: FileReference[];
  config: Record<string, unknown>;
  /**
   * Per-run override delta — the raw object the caller sent in the request
   * body. `config` above is the resolved (deep-merged) snapshot. Persisted
   * separately on `runs.config_override` so the dashboard can badge
   * "default vs override" and a "Re-run with these settings" button can
   * replay the exact same delta. Null when the run used persisted defaults.
   */
  configOverride?: Record<string, unknown> | null;
  modelId?: string | null;
  proxyId?: string | null;
  overrideVersionLabel?: string;
  /**
   * Per-run dependency version overrides (#666). Threaded into
   * `buildRunContext` → `buildAgentPackage` and persisted verbatim on
   * `runs.dependency_overrides`. Null when the run resolved manifest pins.
   */
  dependencyOverrides?: Record<string, string> | null;
  /** Schedule ID — set only for scheduled runs. */
  scheduleId?: string;
  /** Application ID — required for all runs. */
  applicationId: string;
  /** API key ID that triggered the run (if auth via API key). */
  apiKeyId?: string;
  /**
   * Per-(integration, authKey) connection id chosen by the caller for
   * THIS run (#199). Persisted on `runs.connection_overrides` as the
   * audit trail and fed into the resolver's mechanism #2 so the snapshot
   * pins the right row. Loses to admin pins (mechanism #1).
   */
  connectionOverrides?: ConnectionOverrides | null;
  /**
   * Schedule-frozen overrides loaded from `package_schedules.connection_overrides`.
   * Same shape as `connectionOverrides`; loses to both admin pins and
   * per-run overrides. Scheduler path only.
   */
  scheduleConnectionOverrides?: ConnectionOverrides | null;
  /**
   * W3C `traceparent` to seed the run-execution trace tree with. Forwarded
   * into the runtime so its outbound traffic becomes child spans of the
   * platform's trace. Routes resolve this via `runTraceparent(c)`, which
   * honors `OTEL_TRUST_INCOMING_TRACE`: the inbound header only when trusted,
   * otherwise the in-process SERVER span. Background runners (scheduler) leave
   * it unset.
   */
  traceparent?: string;
  /** Resolved by `lib/runner-context.ts` from request headers + auth context. */
  runnerName?: string | null;
  runnerKind?: string | null;
  /**
   * Per-call-graph memo for integration manifest fetches. The run route
   * creates one Map and passes it to BOTH `resolveRunPreflight` and
   * `prepareAndExecuteRun` so the readiness pass, the connection-snapshot
   * pass, and the spawn resolver share one SELECT + Zod parse per
   * integration. Callers that omit it (scheduler, inline runs) still get
   * intra-pipeline dedupe via the default Map created below.
   */
  manifestCache?: IntegrationManifestCache;
}

export interface RunPipelineSuccess {
  runId: string;
  /**
   * Resolved model label snapshot — same value persisted on
   * `runs.model_label`. Echoed by the run route so callers can detect
   * org-default drift at trigger time (#635).
   */
  modelLabel: string | null;
  modelSource: string | null;
}

// ---------------------------------------------------------------------------
// Preflight — shared by run route and scheduler
// ---------------------------------------------------------------------------

export interface PreflightResult {
  config: Record<string, unknown>;
  modelId: string | null;
  proxyId: string | null;
}

/**
 * Resolve package config and validate agent readiness.
 * Shared by the POST /run route and the scheduler's triggerScheduledRun.
 *
 * Connection overrides are forwarded to readiness so a caller that
 * disambiguates a must_choose situation via `connection_overrides` on
 * the run body / schedule row gets past the readiness gate on retry
 * (otherwise readiness re-fires must_choose on the same N>1 candidate
 * set and the picker UX loop never exits).
 */
export async function resolveRunPreflight(params: {
  agent: LoadedPackage;
  applicationId: string;
  orgId: string;
  actor: Actor | null;
  connectionOverrides?: ConnectionOverrides | null;
  scheduleConnectionOverrides?: ConnectionOverrides | null;
  /**
   * Per-call-graph memo for integration manifest fetches — pass the same Map
   * given to `prepareAndExecuteRun` so the readiness pass shares its manifest
   * loads with the pipeline's snapshot + spawn passes.
   */
  manifestCache?: IntegrationManifestCache;
}): Promise<PreflightResult> {
  const { agent, applicationId, orgId, actor } = params;

  const packageConfig = await getPackageConfig(applicationId, agent.id);

  await validateAgentReadiness({
    agent,
    orgId,
    config: packageConfig.config,
    applicationId,
    actor,
    ...(params.connectionOverrides ? { runOverrides: params.connectionOverrides } : {}),
    ...(params.scheduleConnectionOverrides
      ? { scheduleOverrides: params.scheduleConnectionOverrides }
      : {}),
    ...(params.manifestCache ? { manifestCache: params.manifestCache } : {}),
  });

  return {
    config: packageConfig.config,
    modelId: packageConfig.modelId,
    proxyId: packageConfig.proxyId,
  };
}

// ---------------------------------------------------------------------------
// Spawn-dependency freeze (#686) — shared across origins
// ---------------------------------------------------------------------------

/**
 * Validate `dependency_overrides` keys and freeze every declared integration's
 * manifest version against PUBLISHED versions honoring its pin (+ overrides).
 *
 * The single point the integration pin is enforced for a run, shared by EVERY
 * origin — platform (`prepareAndExecuteRun`), scheduled (same), and remote
 * (`run-creation.createRun`). Extracting it is what closes the remote-origin
 * gap: before, only the platform path froze versions, so a remote run silently
 * served the mutable draft on the credential path (the exact #686 bug class on
 * a different origin).
 *
 *   - Rejects an override KEY that names no declared skill/integration with a
 *     400 (the "fails silently on the key axis" trap the value gate can't see).
 *   - Seeds the shared `manifestCache` (when given) so every kickoff reader
 *     threading it honors the pin with no per-caller change.
 *   - Throws a structured `dependency_unresolved` (422) on an unsatisfiable /
 *     never-published pin — never a silent draft fallback.
 *
 * Returns the frozen `{ version, source }` map to persist on
 * `runs.resolved_integration_versions`.
 */
export async function freezeRunSpawnDependencies(params: {
  agent: LoadedPackage;
  /**
   * The run's org — required tenant boundary for published-version
   * resolution (defense in depth against a cross-tenant reference).
   */
  orgId: string;
  dependencyOverrides?: Record<string, string> | null;
  manifestCache?: IntegrationManifestCache;
}): Promise<ResolvedIntegrationVersionMap> {
  if (params.dependencyOverrides) {
    const declaredDeps = collectOverridableDependencyIds(
      params.agent.manifest as Record<string, unknown>,
    );
    const unknownKey = Object.keys(params.dependencyOverrides).find(
      (key) => !declaredDeps.has(key),
    );
    if (unknownKey) {
      throw new ApiError({
        status: 400,
        code: "invalid_request",
        title: "Bad Request",
        detail: `\`dependency_overrides["${unknownKey}"]\` is not a declared skill or integration dependency of this agent`,
      });
    }
  }

  const resolved = await resolveRunIntegrationVersions({
    agentManifest: params.agent.manifest as Record<string, unknown>,
    orgId: params.orgId,
    dependencyOverrides: params.dependencyOverrides ?? null,
    manifestCache: params.manifestCache,
  });
  if (!resolved.ok) {
    const list = resolved.unresolved.map((m) => `'${m.name}@${m.versionSpec}'`).join(", ");
    throw new ApiError({
      status: 422,
      code: "dependency_unresolved",
      title: "Dependency Unresolved",
      detail: `Could not resolve ${list} against published versions — publish the integration, fix the pin, or pass \`dependency_overrides\` to run a working copy.`,
    });
  }
  return resolved.versions;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/**
 * Build run context, run module pre-checks, create run record, and fire-and-forget execution.
 *
 * Throws `ApiError` on validation / preflight failures (model not configured,
 * rate limit, concurrency, beforeRun hook rejection) so the HTTP error handler
 * can surface RFC 9457 problem details directly. Background callers (scheduler)
 * catch `ApiError` to translate into their own failure semantics.
 */
export async function prepareAndExecuteRun(params: RunPipelineParams): Promise<RunPipelineSuccess> {
  const {
    runId,
    orgId,
    actor,
    input,
    files,
    config,
    modelId,
    proxyId,
    overrideVersionLabel,
    scheduleId,
    applicationId,
    apiKeyId,
  } = params;
  // Per-call-graph manifest memo: reuse the caller's Map (run route — shares
  // loads with its earlier `resolveRunPreflight` call) or create one scoped
  // to this pipeline invocation (scheduler / inline runs) so Step 2's
  // snapshot pass and Step 3's spawn resolver still dedupe between them.
  const manifestCache: IntegrationManifestCache = params.manifestCache ?? new Map();
  // Per-stage wall-clock timings — emitted as one structured line at the end so
  // the ~1.75 s pre-createRun pipeline is decomposable in prod without a tracer.
  const pipelineStart = Date.now();
  const spanAttributes = { "appstrate.run.id": runId, "appstrate.org.id": orgId };
  // --- Step 1: Shared preflight gates (rate, concurrency, timeout cap,
  //     beforeRun hook). Shared with the remote origin in run-creation.ts so
  //     drift across the two paths is impossible — one change surface.
  const gatesStart = Date.now();
  const gates = await runWithSpan("appstrate.run.gates", { attributes: spanAttributes }, () =>
    runPreflightGates({
      orgId,
      agent: params.agent,
    }),
  );
  const gatesMs = Date.now() - gatesStart;
  if (!gates.ok) {
    throw new ApiError({
      status: gates.error.status ?? 500,
      code: gates.error.code,
      title: gates.error.code.replace(/_/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase()),
      detail: gates.error.message,
    });
  }
  const { agent } = gates;

  // --- Step 2a: Integration manifest version snapshot (#686) ---
  //
  // Validate `dependency_overrides` keys and freeze every declared
  // integration's manifest version against PUBLISHED versions honoring its
  // `dependencies.integrations.<id>` pin (+ any `dependency_overrides`), BEFORE
  // the connection cascade and the spawn resolver run. Seeding the shared
  // `manifestCache` makes both honor the pin transparently; the frozen map is
  // persisted so the runtime credential path resolves the SAME version. An
  // unsatisfiable pin fails loud (422), never a silent draft spawn. Shared with
  // the remote origin (`run-creation.ts`) via `freezeRunSpawnDependencies`.
  const freezeStart = Date.now();
  const resolvedIntegrationVersions: ResolvedIntegrationVersionMap = await runWithSpan(
    "appstrate.run.freeze",
    { attributes: spanAttributes },
    () =>
      freezeRunSpawnDependencies({
        agent,
        orgId,
        dependencyOverrides: params.dependencyOverrides ?? null,
        manifestCache,
      }),
  );
  const freezeMs = Date.now() - freezeStart;

  // --- Step 2b: Connection resolution snapshot (#199) ---
  //
  // Apply the 4-mechanism cascade once at kickoff so:
  //  - the spawn loader (run-context-builder) pins the same row admin/run intended,
  //  - the credentials resolver (sidecar MITM refresh) honours that pick
  //    long after kickoff via runs.resolved_connections.
  //
  // Readiness already ran in resolveRunPreflight WITH the same overrides
  // (so the must_choose retry exits its loop). This second pass produces
  // the persisted resolution snapshot and re-checks under the current DB
  // state — any error here is hard 412: either the override points at an
  // invalid id (caller's mistake), or a race after readiness mutated DB
  // state (connection deleted / pin shifted). Either way the caller
  // needs structured feedback, not a silent fallback. The cascade reads the
  // pinned manifests seeded by Step 2a (auth keys / scopes match the spawn).
  let resolvedConnections: ResolvedConnectionMap | null = null;
  let connectionsMs = 0;
  // An actor-less run leaves the connection snapshot null (nothing to pin).
  // Scheduled actor-less runs that declare integrations never reach here —
  // the scheduler fail-fasts first (#735); other run paths always have an actor.
  if (actor) {
    const connectionsStart = Date.now();
    const outcome = await runWithSpan(
      "appstrate.run.connections",
      { attributes: spanAttributes },
      () =>
        resolveRunConnectionsOrError({
          agentManifest: agent.manifest as Record<string, unknown>,
          packageId: agent.id,
          actor,
          scope: { orgId, applicationId },
          runOverrides: params.connectionOverrides ?? null,
          scheduleOverrides: params.scheduleConnectionOverrides ?? null,
          manifestCache,
        }),
    );
    connectionsMs = Date.now() - connectionsStart;
    if (!outcome.ok) {
      throw new ApiError({
        status: outcome.error.status,
        code: outcome.error.code,
        title: outcome.error.title,
        detail: outcome.error.detail,
        errors: outcome.error.errors,
      });
    }
    resolvedConnections = outcome.resolved;
  }

  // --- Step 3: Build run context ---
  let context;
  let plan;
  let agentPackage: Buffer | null;
  let versionLabel: string | null;
  let versionRef: string;
  let proxyLabel: string | null;
  let modelLabel: string | null;
  let modelSource: string | null;
  let contextMs: number;
  const contextStart = Date.now();
  try {
    ({
      context,
      plan,
      agentPackage,
      versionLabel,
      versionRef,
      proxyLabel,
      modelLabel,
      modelSource,
    } = await runWithSpan("appstrate.run.context", { attributes: spanAttributes }, () =>
      buildRunContext({
        runId,
        agent,
        orgId,
        applicationId,
        actor,
        input: input ?? undefined,
        files,
        config,
        modelId,
        proxyId,
        overrideVersionLabel,
        dependencyOverrides: params.dependencyOverrides ?? null,
        traceparent: params.traceparent,
        resolvedConnections,
        manifestCache,
      }),
    ));
    contextMs = Date.now() - contextStart;
  } catch (err) {
    if (err instanceof ModelNotConfiguredError) {
      throw new ApiError({
        status: 400,
        code: "model_not_configured",
        title: "Bad Request",
        detail: err.message,
      });
    }
    if (err instanceof ModelCredentialMissingError) {
      throw new ApiError({
        status: 400,
        code: "model_credential_missing",
        title: "Bad Request",
        detail: err.message,
      });
    }
    // Every bundle-layer failure over stored artifacts — an unresolved
    // dependency pin (#666), an integrity mismatch, a signature-policy
    // rejection, a malformed archive — is translated into a coded RFC 9457
    // error BEFORE the container starts, never a silent draft fallback.
    // Anything left unmapped reaches the global handler as an opaque
    // `500 internal_error` with no detail (#878).
    const mapped = toBundleApiError(err);
    if (mapped) throw mapped;
    const browserMapped = toBrowserCapabilityApiError(err);
    if (browserMapped) throw browserMapped;
    throw err;
  }

  // --- Step 4: Mint sink credentials ---
  // Every run — platform and remote — uses the same signed-event
  // protocol. The container reads `APPSTRATE_SINK_URL` +
  // `APPSTRATE_SINK_SECRET` from its env and POSTs CloudEvents back;
  // the platform's event-ingestion pipeline is the single writer.
  //
  // The base URL comes from the orchestrator — `APP_URL` is a public
  // hostname meant for OAuth redirects and CLI clients, not for
  // container-to-platform traffic. Docker orchestrator resolves to the
  // platform's Docker-network hostname (bridge-internal, survives
  // container renames); process orchestrator resolves to loopback.
  const env = getEnv();
  const sinkBaseUrl = await getOrchestrator().resolvePlatformApiUrl();
  const sinkCredentials = mintSinkCredentials({
    runId,
    appUrl: sinkBaseUrl,
    ttlSeconds: env.REMOTE_RUN_SINK_DEFAULT_TTL_SECONDS,
  });

  // --- Step 5: Create run record (with sink state) ---
  const agentDenorm = extractRunAgentDenorm(agent);
  const createStart = Date.now();
  await runWithSpan("appstrate.run.create", { attributes: spanAttributes }, () =>
    createRun(
      { orgId, applicationId },
      {
        id: runId,
        packageId: agent.id,
        actor,
        input: input ?? null,
        scheduleId,
        versionLabel: versionLabel ?? undefined,
        versionRef,
        proxyLabel: proxyLabel ?? undefined,
        modelLabel: modelLabel ?? undefined,
        modelSource: modelSource ?? undefined,
        apiKeyId,
        agentScope: agentDenorm.scope,
        agentName: agentDenorm.name,
        config,
        configOverride: params.configOverride ?? null,
        dependencyOverrides: params.dependencyOverrides ?? null,
        runOrigin: "platform",
        sinkSecretEncrypted: encrypt(sinkCredentials.secret),
        sinkExpiresAt: new Date(sinkCredentials.expiresAt),
        connectionOverrides: params.connectionOverrides ?? null,
        resolvedConnections,
        resolvedIntegrationVersions,
        runnerName: params.runnerName ?? null,
        runnerKind: params.runnerKind ?? null,
        // Model aliases (issue #727, Threat A): the run DTO (`state/runs.ts`)
        // emits `modelCredentialId` to any dashboard user who can read the run,
        // and a credential id cross-references — via GET /api/model-provider-
        // credentials → `available_model_ids` — straight to the backing model.
        // Drop it for aliases; the operator audit trail already recorded the
        // create. Non-aliased runs keep it for the connections/credentials panel.
        modelCredentialId: plan.llmConfig.aliased ? null : (plan.llmConfig.credentialId ?? null),
      },
    ),
  );
  const createMs = Date.now() - createStart;

  logger.info("run pipeline timings", {
    runId,
    gatesMs,
    rateLimitMs: gates.timings.rateLimitMs,
    concurrencyMs: gates.timings.concurrencyMs,
    beforeRunHookMs: gates.timings.beforeRunHookMs,
    freezeMs,
    connectionsMs,
    contextMs,
    createMs,
    totalMs: Date.now() - pipelineStart,
  });

  // Platform-written progress breadcrumb — first feedback the run page can
  // render, streamed live over the same run_logs pg_notify → SSE path the
  // container's own breadcrumbs use (same type/event/level combo). Emitted
  // right after the row exists so the UI shows something well before the
  // container's first event (~1.3 s later). Best-effort: a failed breadcrumb
  // must never fail the run.
  void appendRunLog(
    { orgId },
    runId,
    "progress",
    "progress",
    "run created · starting containers",
    { platform: true },
    "info",
  ).catch((err) => {
    logger.warn("failed to append platform progress log (run created)", {
      runId,
      error: getErrorMessage(err),
    });
  });

  // --- Step 6: Fire-and-forget execution ---
  executeAgentInBackground({
    runId,
    orgId,
    applicationId,
    agent,
    context,
    plan,
    agentPackage,
    modelSource,
    sinkCredentials,
  }).catch((err) => {
    logger.error("Unhandled error in background run", {
      runId,
      error: getErrorMessage(err),
    });
  });

  return { runId, modelLabel, modelSource };
}
