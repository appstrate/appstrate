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
  assertRunnableOnEngine,
  assertSubscriptionEngineIsolation,
  assertVendRunHasNoIntegrations,
  buildOauthSidecarLlm,
  resolveCredentialDelivery,
} from "./subscription-run-policy.ts";
import { getExecutionMode } from "../../infra/mode.ts";
import { providerHasNativeOutput } from "../model-providers/registry.ts";
import {
  getOrchestrator,
  type ContainerOrchestrator,
  type WorkloadHandle,
  type IsolationBoundary,
} from "../orchestrator/index.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import type { ExecutionContext } from "@appstrate/afps-runtime/types";
import type { SinkCredentials } from "../../lib/mint-sink-credentials.ts";
import { uploadRunBundle, deleteRunWorkspace } from "../run-workspace-storage.ts";
import {
  runWithSpan,
  currentTraceparent,
  recordContainerSpawn,
} from "../../observability/index.ts";

import { getEnv } from "@appstrate/env";
import { getModelProvider } from "../model-providers/registry.ts";
import type { LlmProxyConfig, SidecarLaunchSpec } from "@appstrate/core/sidecar-types";

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
  orchestrator?: ContainerOrchestrator;
  /**
   * Injectable workspace provisioning — production defaults to the
   * run-workspace storage helpers. The agent fetches the bundle itself at
   * startup; input documents were already streamed into the workspace during
   * upload-consume. Tests substitute a capturing stub.
   */
  uploadBundle?: typeof uploadRunBundle;
  deleteWorkspace?: typeof deleteRunWorkspace;
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

  const prompt = await buildPlatformSystemPrompt(context, plan);
  const { llmConfig } = plan;
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
    // Fail-closed BEFORE provisioning any isolation boundary: a subscription
    // AGENT run (claude-code → Claude Agent SDK, codex → Codex CLI) must execute
    // under the docker orchestrator. The process orchestrator runs in-host and
    // would expose the subscription credential to the API process. API-key
    // providers are unaffected.
    assertSubscriptionEngineIsolation({
      providerId: llmConfig.providerId,
      orchestratorMode: getExecutionMode(),
    });

    boundary = await orch.createIsolationBoundary(runId);

    const llmApiKey = llmConfig.apiKey;

    // Single source of truth for "what kind of credential is this and how is it
    // delivered". Reads the provider→engine registry ONCE (plus the oauth-class
    // flag for the engine-less refuse path); the delivery mode, the oauth-class
    // boolean, the resolved engine, and the egress allowlist all flow from here,
    // replacing the former parallel `isOAuthModelProvider` axis.
    const delivery = resolveCredentialDelivery({
      providerId: llmConfig.providerId,
      hasCredentialId: !!llmConfig.credentialId,
    });
    // OAuth credentials must take the sidecar's OAuth branch — the API-key
    // path can't refresh tokens or inject the provider's identity routing
    // headers at request time.
    const isOauthCredential = delivery.isOauthCredential;

    // The placeholder is what actually lands in MODEL_API_KEY inside the
    // agent container. Provider-specific shape (e.g. a structured JWT) is
    // built by the module's `buildApiKeyPlaceholder` hook — see
    // `deriveOauthPlaceholder` below.
    const llmPlaceholder = isOauthCredential
      ? deriveOauthPlaceholder(llmApiKey, llmConfig.providerId)
      : deriveKeyPlaceholder(llmApiKey);

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

    // Model-alias swap descriptor (LLM-gateway alias pattern). The container is
    // handed the public alias as MODEL_ID (below); the sidecar swaps it for the
    // real upstream id on every call. The real id never enters the container.
    const modelSwap = llmConfig.aliased
      ? { alias: llmConfig.aliasId, real: llmConfig.modelId }
      : undefined;

    // Engine selection (Pi vs the official Claude Agent SDK). Resolved from the
    // same single source as the credential delivery, reused for both the sidecar
    // `/llm` mode and the container's RUN_ENGINE.
    const engine = delivery.engine;
    // No fingerprint-forging fallback: an OAuth subscription provider can only
    // run on an engine whose driver signs its own fingerprint (claude-code →
    // the Claude Agent SDK). A provider with no official engine (e.g. a future
    // oauth provider with no official engine) is rejected here. (codex DOES have
    // an engine — it resolves to engine "codex" / mode "vend" and is accepted.)
    assertRunnableOnEngine({
      engine,
      providerId: llmConfig.providerId,
      isOauthCredential,
    });

    let sidecarLlm: LlmProxyConfig | undefined;
    // Credential delivery is driven by the single `resolveCredentialDelivery`
    // value (which reads the provider→engine registry), not an engine literal: a
    // `"vend"` subscription engine holds the real token in-container (the binary
    // talks to the upstream directly; no reverse proxy is possible) and locks
    // egress to the vendor's hosts; an `"oauth"` engine has its bearer swapped
    // server-side by the gateway. Adding a new subscription engine is a registry
    // entry, not a branch here.
    const egressAllowlist = delivery.egressAllowlist;
    // M4 — pre-flight: vend AND oauth both dereference `credentialId` below.
    // Assert it HERE (before any boundary/container is provisioned) so a missing
    // credential fails fast with a clear message instead of the non-null `!`
    // shipping `undefined`, which would otherwise surface as an opaque sidecar
    // boot crash AFTER both containers were already launched.
    if ((delivery.mode === "vend" || isOauthCredential) && !llmConfig.credentialId) {
      throw new Error(
        `Run launcher: ${delivery.mode === "vend" ? "vend" : "oauth"}-mode run for provider ` +
          `"${llmConfig.providerId}" has no resolved credentialId — cannot deliver the credential.`,
      );
    }
    // H1 — keep all three runners (pi / claude / codex) on ONE trust model (the
    // per-run network is the boundary; sidecar-internal endpoints are gated by
    // network membership alone). A vend run is the only one holding a real token
    // in-container, so it must not place untrusted integration siblings on that
    // network. Single-source guard in subscription-run-policy (mirrors the runnable /
    // isolation guards above); fails closed before any boundary is provisioned.
    assertVendRunHasNoIntegrations({
      mode: delivery.mode,
      providerId: llmConfig.providerId,
      integrationCount: plan.integrations?.length ?? 0,
    });
    if (delivery.mode === "vend") {
      // Vend mode: the sidecar hands the resolved token to the in-container
      // runner via `/credential-vend` instead of swapping the bearer in flight.
      // No model alias (subscription models aren't aliased).
      //
      // The egress allowlist is REQUIRED on the vend config: a vend run hands the
      // REAL subscription token into the container (the CLI talks to the upstream
      // directly and can't be reverse-proxied), so egress MUST be locked to the
      // provider's hosts — the allowlist is the sole compensating control. Fail
      // closed rather than launch an unconstrained container holding a live
      // credential. (`resolveCredentialDelivery` always supplies the codex egress
      // allowlist for a vend run; this guards against shipping without its lock.)
      // Carrying it ON the vend config (not a sibling spec field) makes the
      // `vend ⟺ allowlist` invariant structural — the type can't express one
      // without the other.
      if (!egressAllowlist || egressAllowlist.length === 0) {
        throw new Error(
          "vend-mode run requires a non-empty egress allowlist (refusing to launch an unlocked container with a vended credential)",
        );
      }
      sidecarLlm = {
        authMode: "vend",
        credentialId: llmConfig.credentialId!,
        egressAllowlist,
      };
    } else if (isOauthCredential) {
      // An `"oauth"` subscription engine (e.g. Claude Agent SDK). The official
      // binary signs its own fingerprint, so the sidecar just swaps the bearer
      // + ensures the OAuth beta — no forging.
      sidecarLlm = buildOauthSidecarLlm({
        baseUrl: llmConfig.baseUrl,
        credentialId: llmConfig.credentialId!,
        ...(modelSwap ? { modelSwap } : {}),
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

    // Native-output providers (e.g. claude-code) materialise `output` themselves
    // → strip it from the tools the sidecar serves so the model sees a single
    // output path. Driven by the PROVIDER's declared capability (not the engine),
    // so a second provider on the same engine that lacks native output keeps its
    // MCP `output` path, and a future native-output provider needs no launcher edit.
    const sidecarRuntimeTools = providerHasNativeOutput(llmConfig.providerId)
      ? plan.runtimeTools?.filter((t) => t !== "output")
      : plan.runtimeTools;

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
      //
      // Claude takes the structured deliverable NATIVELY (SDK `outputFormat` →
      // `structured_output`), so it must NOT also be offered an MCP `output`
      // tool — two output mechanisms would be ambiguous for the model and the
      // runner would drain a journaled `output.emitted` on top of the native
      // one. Strip `output` from what the sidecar serves for claude runs; the
      // schema still reaches the runner via OUTPUT_SCHEMA for the native path.
      ...(sidecarRuntimeTools && sidecarRuntimeTools.length > 0
        ? { runtimeTools: sidecarRuntimeTools }
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
      engine,
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
      noSidecar: skipSidecar,
      // Sidecar-backed runs route LLM traffic through the sidecar proxy
      // (sidecarProxyLlmUrl below). No-sidecar runs talk to the upstream
      // directly, so buildRuntimePiEnv derives MODEL_BASE_URL from the
      // model's own baseUrl (passed in `model` above) — otherwise the Pi
      // SDK falls back to the api-shape's native default (api.openai.com)
      // and misroutes custom-baseUrl providers like DeepSeek. See #741.
      sidecarProxyLlmUrl: skipSidecar
        ? undefined
        : llmApiKey
          ? "http://sidecar:8080/llm"
          : undefined,
      outputSchema: hasOutputSchema ? plan.outputSchema : undefined,
      forwardProxyUrl: skipSidecar ? undefined : "http://sidecar:8081",
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
        },
        boundary,
      ),
      uploadBundle(runId, plan.agentPackage ?? undefined),
    ]);
    sidecarHandle = sidecar;
    agentHandle = agent;
    recordContainerSpawn(Date.now() - spawnStart, { sidecar: !skipSidecar });
    spawnRecorded = true;

    return await waitForWorkload(orch, agent, sidecar, plan.timeout, signal);
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
 * Drive the agent container lifecycle: start, enforce timeout, propagate
 * cancellation, wait for exit. Sidecar is stopped alongside the agent on
 * any terminal condition so neither lingers after the run has ended.
 */
async function waitForWorkload(
  orch: ContainerOrchestrator,
  agent: WorkloadHandle,
  sidecar: WorkloadHandle | undefined,
  timeoutSeconds: number,
  signal: AbortSignal | undefined,
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
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    orch.stopWorkload(agent).catch(() => {});
    if (sidecar) orch.stopWorkload(sidecar).catch(() => {});
  }, timeoutSeconds * 1000);

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
