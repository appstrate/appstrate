// SPDX-License-Identifier: Apache-2.0

/**
 * Pi-container platform runner — spawns the sidecar + agent workloads for a
 * single run, waits for the agent container to exit, and reports the terminal
 * lifecycle state back to the caller.
 *
 * No event iteration. No stdout parsing. The agent container uses
 * {@link HttpSink} (wired via `APPSTRATE_SINK_URL` + `APPSTRATE_SINK_SECRET`)
 * to POST every {@link RunEvent} + its terminal {@link RunResult} directly
 * to the platform's signed-event API. The platform's event-ingestion
 * pipeline is the single persistence path for every run — platform or
 * remote — and the server-side `executeAgentInBackground` is reduced to
 * container lifecycle management.
 *
 * On graceful completion the container itself calls `sink.finalize(result)`
 * and the server's `finalizeRun()` closes the sink idempotently. If
 * the container crashes or times out without calling finalize, the caller
 * synthesises a terminal result from {@link PlatformContainerResult} and
 * re-enters `finalizeRun()` — the CAS on `sink_closed_at IS NULL`
 * guarantees exactly-once closure even when container-side and
 * server-side finalize race.
 */

import { logger } from "../../lib/logger.ts";
import type { AppstrateRunPlan } from "./types.ts";
import { buildPlatformSystemPrompt } from "./prompt-builder.ts";
import { buildRuntimePiEnv } from "@appstrate/runner-pi";
import {
  assertOauthRunIsolation,
  assertOauthRunNotAliased,
  buildOauthSidecarLlm,
  resolveCredentialDelivery,
} from "./subscription-run-policy.ts";
import { getExecutionMode } from "../../infra/mode.ts";
import {
  getOrchestrator,
  type RunOrchestrator,
  type WorkloadHandle,
  type IsolationBoundary,
} from "../orchestrator/index.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import type { ExecutionContext } from "@appstrate/afps-runtime/types";
import type { SinkCredentials } from "../../lib/mint-sink-credentials.ts";
import { uploadRunBundle, deleteRunWorkspace } from "../run-workspace-storage.ts";
import { runWithSpan, currentTraceparent, recordContainerSpawn } from "@appstrate/core/telemetry";

import { getEnv } from "@appstrate/env";
import { getModelProvider } from "../model-providers/registry.ts";
import type { LlmProxyConfig, SidecarLaunchSpec } from "@appstrate/core/sidecar-types";

/**
 * Grace added to the platform's container watchdog on top of the agent's
 * execution budget. The runner enforces `plan.timeout` ITSELF from the moment
 * its run loop starts (boot excluded) and finalises a first-class `timeout`.
 * This platform-side timer is the SAFETY NET for the cases the runner can't
 * cover — a container wedged in cold-start/boot before its watchdog arms, or a
 * runner that died without finalising. The grace folds in cold-start (image
 * pull, workspace init, MCP handshake) so a slow boot does not trip the net
 * before the runner has had its full budget. When it does fire,
 * `execute-background` synthesises the `timeout` terminal.
 */
const PLATFORM_TIMEOUT_BOOT_GRACE_MS = 90_000;

/** Terminal state reported back to the caller once the container has exited. */
export interface PlatformContainerResult {
  /** Exit code reported by the orchestrator (0 = clean, non-zero = crash). */
  exitCode: number;
  /** Whether the agent container was stopped because the run timed out. */
  timedOut: boolean;
  /** Whether the run was cancelled by the caller's `AbortSignal`. */
  cancelled: boolean;
}

export interface RunPlatformContainerInput {
  runId: string;
  context: ExecutionContext;
  plan: AppstrateRunPlan;
  /** Sink credentials minted by the caller (`createRun`). Required. */
  sinkCredentials: SinkCredentials;
  /** Cancellation token — aborted = the run was cancelled by user. */
  signal?: AbortSignal;
  /** Injectable orchestrator — production defaults to the global singleton. */
  orchestrator?: RunOrchestrator;
  /**
   * Injectable workspace provisioning — production defaults to the
   * run-workspace storage helpers. The agent fetches the bundle itself at
   * startup; input documents were already streamed into the workspace during
   * upload-consume. Tests substitute a capturing stub.
   */
  uploadBundle?: typeof uploadRunBundle;
  deleteWorkspace?: typeof deleteRunWorkspace;
  /**
   * Grace (ms) added to `plan.timeout` for the platform's safety-net
   * container watchdog. Defaults to {@link PLATFORM_TIMEOUT_BOOT_GRACE_MS}.
   * Tests that exercise the net directly (no real runner to self-terminate)
   * set it to `0` so the net fires at the budget itself.
   */
  timeoutBootGraceMs?: number;
}

/**
 * Start the Pi agent + sidecar for a platform-origin run, wait until the
 * agent container exits, and report the lifecycle outcome. The returned
 * {@link PlatformContainerResult} is consumed by the caller to synthesise
 * a terminal {@link finalizeRun} call when the container didn't
 * finalise itself.
 *
 * Never throws on container-side failures — the lifecycle outcome is
 * encoded in the returned shape. Only unexpected orchestrator errors
 * (e.g. Docker unreachable) propagate as exceptions.
 */
export async function runPlatformContainer(
  input: RunPlatformContainerInput,
): Promise<PlatformContainerResult> {
  // Container-lifecycle span — a child of the run-pipeline span (or root when
  // disabled). `currentTraceparent()` (inside the impl) forwards THIS span as
  // the parent of the agent container's outbound events, so the container nests
  // under it. A true no-op when observability is disabled.
  return runWithSpan(
    "appstrate.run.container",
    { attributes: { "appstrate.run.id": input.runId } },
    () => runPlatformContainerImpl(input),
  );
}

async function runPlatformContainerImpl(
  input: RunPlatformContainerInput,
): Promise<PlatformContainerResult> {
  const { runId, context, plan, sinkCredentials, signal } = input;
  const orch = input.orchestrator ?? getOrchestrator();
  const uploadBundle = input.uploadBundle ?? uploadRunBundle;
  const deleteWorkspace = input.deleteWorkspace ?? deleteRunWorkspace;

  const { llmConfig } = plan;

  // Single source of truth for "what kind of credential is this and how is it
  // delivered". Classified by the provider's declared authMode: an oauth-class
  // credential is delivered via the sidecar `/llm` bearer-swap; everything
  // else is a static API-key placeholder substitution. Fail-closed: an OAuth
  // provider that resolved WITHOUT a stored credential id throws here (invalid
  // configuration — it must never downgrade to API-key handling, which would
  // leak the raw token into the agent container and skip the sidecar).
  const delivery = resolveCredentialDelivery({
    providerId: llmConfig.providerId,
    hasCredentialId: !!llmConfig.credentialId,
  });

  const prompt = await buildPlatformSystemPrompt(context, plan);
  // The container's MODEL_ID is the PUBLIC id: the alias for a model alias, the
  // real id otherwise. The agent sends it verbatim as the request `model`; the
  // sidecar swaps alias→real upstream. The real backing id never enters the
  // container env for an alias.
  const modelId = llmConfig.aliased ? llmConfig.aliasId : llmConfig.modelId;

  let boundary: IsolationBoundary | undefined;
  let sidecarHandle: WorkloadHandle | undefined;
  let agentHandle: WorkloadHandle | undefined;

  // Hoisted out of the try so the spawn-failure metric path (catch) can read
  // it. Assigned below once the run's sidecar policy is resolved.
  let skipSidecar = false;

  const spawnStart = Date.now();
  // Guards against double-recording the container-spawn histogram: the success
  // record fires before `waitForWorkload`, so a later execution failure (which
  // is NOT a spawn failure) must not also emit a spawn data point.
  let spawnRecorded = false;
  try {
    // Fail-closed BEFORE provisioning any isolation boundary: an OAuth run
    // delivers its credential via the sidecar `/llm` bearer-swap, which only an
    // isolating orchestrator (docker, firecracker) provisions. The in-host
    // process orchestrator has no sidecar to swap the bearer. API-key providers
    // are unaffected.
    assertOauthRunIsolation({
      isOauthCredential: delivery.isOauthCredential,
      providerId: llmConfig.providerId,
      orchestratorMode: getExecutionMode(),
    });
    // The oauth sidecar mode is a pure bearer-swap — it carries no modelSwap,
    // so an aliased subscription model can neither work nor stay masked.
    // Alias creation already rejects oauth credentials; fail-closed here for
    // any row predating that rule.
    assertOauthRunNotAliased({
      isOauthCredential: delivery.isOauthCredential,
      aliased: !!llmConfig.aliased,
      providerId: llmConfig.providerId,
    });

    const llmApiKey = llmConfig.apiKey;

    // OAuth credentials must take the sidecar's OAuth branch — the API-key
    // path can't refresh tokens or inject the provider's identity routing
    // headers at request time.
    const isOauthCredential = delivery.isOauthCredential;

    // Skip the sidecar entirely when the run declares no integrations AND
    // uses a static API key AND has no egress proxy. The sidecar's purposes
    // are integration MCP multiplexing (Phase 1.4), LLM passthrough for
    // OAuth, AND hosting the forward proxy that masks the agent's outbound
    // IP. An API-key model with no integrations and no proxy needs none of
    // these. When a proxy IS configured, the sidecar's forward-proxy bind
    // is the ONLY path that routes agent egress through it — skipping the
    // sidecar would silently drop the proxy and leak the host IP.
    const hasIntegrations = (plan.integrations?.length ?? 0) > 0;
    // A model alias MUST route through the sidecar — that's the only place the
    // `model` alias→real swap happens. Skipping it would hand the agent the
    // real backing id (in its own request) and the provider's real endpoint.
    skipSidecar =
      !hasIntegrations &&
      !!llmConfig.apiKey &&
      !isOauthCredential &&
      !plan.proxyUrl &&
      !llmConfig.aliased;

    // Resolved BEFORE the boundary so port-allocating backends don't
    // reserve a sidecar port this run will never bind.
    boundary = await orch.createIsolationBoundary(runId, { skipSidecar });

    // The placeholder is what actually lands in MODEL_API_KEY inside the
    // agent container. Provider-specific shape (e.g. a structured JWT) is
    // built by the module's `buildApiKeyPlaceholder` hook — see
    // `deriveOauthPlaceholder` below.
    const llmPlaceholder = isOauthCredential
      ? deriveOauthPlaceholder(llmApiKey, llmConfig.providerId)
      : deriveKeyPlaceholder(llmApiKey);

    // Model-alias swap descriptor (LLM-gateway alias pattern). The container is
    // handed the public alias as MODEL_ID (below); the sidecar swaps it for the
    // real upstream id on every call. The real id never enters the container.
    const modelSwap = llmConfig.aliased
      ? { alias: llmConfig.aliasId, real: llmConfig.modelId }
      : undefined;

    let sidecarLlm: LlmProxyConfig | undefined;
    // M4 — pre-flight: an oauth run dereferences `credentialId` below.
    // `resolveCredentialDelivery` already rejects an oauth provider without a
    // credential id, so this branch is normally unreachable — kept as the
    // in-file assertion that keeps the non-null `!` below justified, and as a
    // last belt so a future call-site regression fails fast with a clear
    // message instead of shipping `undefined` into an opaque sidecar boot
    // crash AFTER both containers were already launched.
    if (isOauthCredential && !llmConfig.credentialId) {
      throw new Error(
        `Run launcher: oauth-mode run for provider ` +
          `"${llmConfig.providerId}" has no resolved credentialId — cannot deliver the credential.`,
      );
    }
    if (isOauthCredential) {
      // OAuth subscription: the Pi SDK signs the subscription request shape
      // itself, so the sidecar just swaps the placeholder bearer for the real
      // token — no forging, no modelSwap (aliases rejected above).
      sidecarLlm = buildOauthSidecarLlm({
        baseUrl: llmConfig.baseUrl,
        credentialId: llmConfig.credentialId!,
      });
    } else if (llmApiKey) {
      // API-key flow: the sidecar forwards directly to the upstream
      // provider. The Pi SDK's native retry (Retry-After honoring +
      // exponential backoff, `maxRetries: 2`) covers transient 429/5xx —
      // see `packages/runner-pi/src/pi-runner.ts`.
      sidecarLlm = {
        authMode: "api_key",
        baseUrl: llmConfig.baseUrl,
        apiKey: llmApiKey,
        placeholder: llmPlaceholder,
        ...(modelSwap ? { modelSwap } : {}),
      };
    }

    const sidecarSpec: SidecarLaunchSpec = {
      runToken: plan.runToken ?? "",
      proxyUrl: plan.proxyUrl ?? undefined,
      llm: sidecarLlm,
      // Propagate the resolved model's context window so the sidecar's
      // TokenBudget can spill `api_call` outputs that would push the
      // cumulative tool-output token count past the upstream model's
      // hard limit (#464). Both values are nullable on `org_models`
      // rows; we forward whatever survives the catalog cascade — the
      // sidecar applies a conservative fallback when either is unset.
      ...(llmConfig.contextWindow != null ? { modelContextWindow: llmConfig.contextWindow } : {}),
      ...(llmConfig.maxTokens != null ? { modelMaxTokens: llmConfig.maxTokens } : {}),
      // Phase 1.4 — integrations the sidecar will spawn + multiplex onto
      // the agent-facing `/mcp` surface. Resolved upstream by
      // `resolveIntegrationSpawns` (run-context-builder).
      ...(plan.integrations && plan.integrations.length > 0
        ? { integrations: plan.integrations }
        : {}),
      // Platform runtime tools (output/log/note/pin/report) the sidecar
      // hosts as in-process MCP tools — unified with the integration tool
      // surface. The no-sidecar path reads the same selection from the
      // bundle manifest instead.
      ...(plan.runtimeTools && plan.runtimeTools.length > 0
        ? { runtimeTools: plan.runtimeTools }
        : {}),
    };

    const hasOutputSchema =
      plan.outputSchema?.properties && Object.keys(plan.outputSchema.properties).length > 0;
    // Forward the output schema to the sidecar so its `output` runtime tool
    // can constrain + validate the `data` argument (mirrors the agent
    // container's OUTPUT_SCHEMA env for the no-sidecar path).
    if (hasOutputSchema && plan.outputSchema) {
      sidecarSpec.outputSchema = plan.outputSchema as unknown as Record<string, unknown>;
    }
    // The agent container only ever receives the placeholder
    // (apiKeyPlaceholder); the real access token never leaves the
    // platform/sidecar boundary. The sidecar overwrites Authorization with
    // a fresh upstream token at request time — see `runtime-pi/sidecar/`.
    const containerEnv = buildRuntimePiEnv({
      model: {
        api: llmConfig.apiShape,
        modelId,
        baseUrl: llmConfig.baseUrl,
        apiKey: llmApiKey,
        // When the sidecar is skipped, the agent talks to the upstream
        // provider directly — we must hand it the real API key, not the
        // placeholder the sidecar would normally substitute.
        apiKeyPlaceholder: skipSidecar ? llmApiKey : llmPlaceholder,
        input: llmConfig.input,
        contextWindow: llmConfig.contextWindow,
        maxTokens: llmConfig.maxTokens,
        reasoning: llmConfig.reasoning,
        cost: llmConfig.cost,
      },
      agentPrompt: prompt,
      runId,
      // Forward the execution budget so the runner enforces it itself, from the
      // run-loop start (boot excluded), and finalises a first-class `timeout`.
      // The platform setTimeout in `waitForWorkload` is the longer safety net.
      timeoutSeconds: plan.timeout,
      noSidecar: skipSidecar,
      // All sidecar-relative URLs come from the boundary — the orchestrator
      // owns the topology (Docker DNS alias, host loopback port, in-guest
      // loopback for microVMs) and pi.ts stays backend-agnostic.
      sidecarUrl: skipSidecar ? undefined : boundary.sidecarEndpoints.sidecarUrl,
      // Sidecar-backed runs route LLM traffic through the sidecar proxy
      // (sidecarProxyLlmUrl below). No-sidecar runs talk to the upstream
      // directly, so buildRuntimePiEnv derives MODEL_BASE_URL from the
      // model's own baseUrl (passed in `model` above) — otherwise the Pi
      // SDK falls back to the api-shape's native default (api.openai.com)
      // and misroutes custom-baseUrl providers like DeepSeek. See #741.
      sidecarProxyLlmUrl: skipSidecar
        ? undefined
        : llmApiKey
          ? boundary.sidecarEndpoints.llmProxyUrl
          : undefined,
      outputSchema: hasOutputSchema ? plan.outputSchema : undefined,
      forwardProxyUrl: skipSidecar ? undefined : boundary.sidecarEndpoints.forwardProxyUrl,
      noProxy: skipSidecar ? undefined : boundary.sidecarEndpoints.noProxy,
      sink: {
        url: sinkCredentials.url,
        finalizeUrl: sinkCredentials.finalize_url,
        secret: sinkCredentials.secret,
      },
      // Forward the W3C trace from the spawning request — when set, the
      // container's outbound HTTP traffic (events, finalize, sidecar
      // proxy) becomes child spans of that trace. The runtime validates
      // the wire format and falls back to a fresh trace on malformed
      // values, so no defensive parsing is needed here. When OTel is on,
      // `currentTraceparent()` hands the container THIS container span as
      // its parent; otherwise it returns undefined and we keep forwarding
      // the original request trace unchanged.
      traceparent: currentTraceparent() ?? context.traceparent,
    });

    await orch.ensureImages(
      skipSidecar ? [getEnv().PI_IMAGE] : [getEnv().PI_IMAGE, getEnv().SIDECAR_IMAGE],
    );

    // Sidecar + agent + bundle upload in parallel. The AFPS bundle is uploaded
    // to run-scoped storage; the agent container fetches and extracts it itself
    // at startup (`GET /api/runs/:runId/workspace`). Input documents were
    // already streamed into the same run-workspace namespace during
    // upload-consume — the agent fetches each one (`GET
    // /api/runs/:runId/documents/:name`) and streams it to disk, never buffering
    // the whole payload. This replaces the old seed-into-the-run-volume
    // delivery, whose correctness depended on the volume driver — a tmpfs-backed
    // `local` volume is NOT shared between the short-lived seed helper and the
    // agent container, so the bundle silently vanished and skills never
    // materialised (issue #549). With the agent self-provisioning, the run
    // volume is pure agent-local scratch again, so its backing (disk or tmpfs)
    // is a free performance choice. The upload must finish before
    // `startWorkload` (inside waitForWorkload) so the object exists when the
    // agent boots; racing it alongside the create calls here satisfies that
    // ordering. When `skipSidecar`, only the agent is created (it reaches the
    // platform directly over its egress network).
    const [sidecar, agent] = await Promise.all([
      skipSidecar ? Promise.resolve(undefined) : orch.createSidecar(runId, boundary, sidecarSpec),
      orch.createWorkload(
        {
          runId,
          role: "agent",
          image: getEnv().PI_IMAGE,
          env: containerEnv,
          resources: { memoryBytes: 1536 * 1024 * 1024, nanoCpus: 2_000_000_000 },
          // Without a sidecar there is no egress proxy — the agent must
          // reach the upstream LLM and the platform sink directly, so it
          // goes on the egress network instead of the internal boundary.
          egress: skipSidecar,
          // Hard host-side lifetime ceiling (B2): run budget + the same
          // boot grace the platform safety net uses + a 600 s margin, so
          // the daemon's kill is strictly a LAST resort behind the
          // safety-net setTimeout in waitForWorkload — it only ever fires
          // when the platform died or was partitioned mid-run and its own
          // stop can no longer reach the workload.
          maxLifetimeSeconds:
            plan.timeout +
            Math.ceil((input.timeoutBootGraceMs ?? PLATFORM_TIMEOUT_BOOT_GRACE_MS) / 1000) +
            600,
        },
        boundary,
      ),
      uploadBundle(runId, plan.agentPackage ?? undefined),
    ]);
    sidecarHandle = sidecar;
    agentHandle = agent;
    recordContainerSpawn(Date.now() - spawnStart, { sidecar: !skipSidecar });
    spawnRecorded = true;

    const lifecycle = await waitForWorkload(
      orch,
      agent,
      sidecar,
      plan.timeout,
      signal,
      input.timeoutBootGraceMs ?? PLATFORM_TIMEOUT_BOOT_GRACE_MS,
    );
    return lifecycle;
  } catch (err) {
    // SOTA per OTel "Recording errors": the spawn histogram covers failures too,
    // tagged with a bounded `error.type` naming the phase that failed (no
    // boundary yet ⇒ isolation-boundary create, else workload spawn). Only when
    // the success path has not already recorded — a `waitForWorkload` throw is an
    // execution failure, not a spawn failure, and must not emit a spawn point.
    if (!spawnRecorded) {
      recordContainerSpawn(Date.now() - spawnStart, {
        sidecar: !skipSidecar,
        errorType: boundary ? "workload" : "boundary",
      });
    }
    throw err;
  } finally {
    // Cleanup order: sidecar → agent → network boundary.
    // Removing the network boundary before its members are gone is an
    // error on Docker's side, so the finally chain must be strict.
    if (sidecarHandle) {
      await orch.removeWorkload(sidecarHandle).catch((err) => {
        logger.error("Failed to remove sidecar", {
          runId,
          error: getErrorMessage(err),
        });
      });
    }
    if (agentHandle) {
      await orch.removeWorkload(agentHandle).catch((err) => {
        logger.error("Failed to remove agent workload", {
          runId,
          error: getErrorMessage(err),
        });
      });
    }
    if (boundary) {
      await orch.removeIsolationBoundary(boundary).catch((err) => {
        logger.error("Failed to remove isolation boundary", {
          runId,
          error: getErrorMessage(err),
        });
      });
    }
    // Drop the provisioning archive — the agent has long since fetched it.
    // Best-effort: deleteRunWorkspace never throws.
    await deleteWorkspace(runId);
  }
}

/**
 * Drive the agent container lifecycle: start, enforce the SAFETY-NET timeout
 * (`timeoutSeconds` + {@link PLATFORM_TIMEOUT_BOOT_GRACE_MS} — the runner owns
 * the primary, boot-excluded budget), propagate cancellation, wait for exit.
 * Sidecar is stopped alongside the agent on any terminal condition so neither
 * lingers after the run has ended.
 */
async function waitForWorkload(
  orch: RunOrchestrator,
  agent: WorkloadHandle,
  sidecar: WorkloadHandle | undefined,
  timeoutSeconds: number,
  signal: AbortSignal | undefined,
  bootGraceMs: number,
): Promise<PlatformContainerResult> {
  await orch.startWorkload(agent);

  // Ring-buffer the agent's stdout+stderr so a non-zero exit can be
  // diagnosed. The sink protocol normally carries structured events, but
  // early-boot failures (missing module, malformed env) happen before the
  // sink is wired — those only land on the container's log stream.
  const logBuffer: string[] = [];
  const MAX_LOG_LINES = 200;
  const logAbort = new AbortController();
  const logStream = (async () => {
    try {
      for await (const line of orch.streamLogs(agent, logAbort.signal)) {
        logBuffer.push(line);
        if (logBuffer.length > MAX_LOG_LINES) logBuffer.shift();
      }
    } catch {
      // Log streaming is best-effort — swallow errors.
    }
  })();

  let timedOut = false;
  const timeoutHandle = setTimeout(
    () => {
      timedOut = true;
      orch.stopWorkload(agent).catch(() => {});
      if (sidecar) orch.stopWorkload(sidecar).catch(() => {});
    },
    timeoutSeconds * 1000 + bootGraceMs,
  );

  const onAbort = () => {
    orch.stopWorkload(agent).catch(() => {});
    if (sidecar) orch.stopWorkload(sidecar).catch(() => {});
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    const exitCode = await orch.waitForExit(agent);
    if (exitCode !== 0 && !timedOut && !signal?.aborted) {
      logAbort.abort();
      await logStream;
      logger.error("Agent container exited non-zero", {
        exitCode,
        logs: logBuffer.slice(-50).join("\n"),
      });
    }
    return {
      exitCode,
      timedOut,
      cancelled: signal?.aborted ?? false,
    };
  } finally {
    clearTimeout(timeoutHandle);
    if (signal) signal.removeEventListener("abort", onAbort);
    logAbort.abort();
  }
}

// --- Helpers ---

/**
 * Derive a placeholder that preserves the key's dash-separated prefix.
 * The last segment (the secret) is replaced; prefix segments are kept intact.
 * This ensures the SDK's prefix-based behavior (e.g. OAuth detection, auth header
 * format, beta headers) works identically with the placeholder.
 */
function deriveKeyPlaceholder(key: string | undefined): string {
  if (!key) return "sk-placeholder";
  const parts = key.split("-");
  if (parts.length <= 1) return "sk-placeholder";
  return parts.slice(0, -1).join("-") + "-placeholder";
}

/**
 * Build the `MODEL_API_KEY` placeholder the agent container sees, without
 * leaking the real upstream credential.
 *
 * Provider-specific: the module owns the placeholder shape via its
 * `buildApiKeyPlaceholder` hook (e.g. a synthetic JWT carrying only the
 * routing claim pi-ai's in-container LLM client will read). When the hook
 * is absent or returns null, the platform falls back to the generic
 * dash-stripping strategy — safe for opaque bearer tokens.
 */
function deriveOauthPlaceholder(key: string | undefined, providerId: string): string {
  if (!key) return deriveKeyPlaceholder(key);
  const config = getModelProvider(providerId);
  const fromHook = config?.hooks?.buildApiKeyPlaceholder?.(key);
  return fromHook ?? deriveKeyPlaceholder(key);
}

/** @internal Exported for testing */
export {
  deriveKeyPlaceholder as _deriveKeyPlaceholderForTesting,
  deriveOauthPlaceholder as _deriveOauthPlaceholderForTesting,
};
