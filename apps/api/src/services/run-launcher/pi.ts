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

import { randomBytes } from "node:crypto";
import { logger } from "../../lib/logger.ts";
import type { AppstrateRunPlan } from "./types.ts";
import { buildPlatformSystemPrompt } from "./prompt-builder.ts";
import { buildRuntimePiEnv } from "@appstrate/runner-pi";
import { ALIAS_CLIENT_API_SHAPE } from "@appstrate/core/model-swap";
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
import { uploadRunBundle } from "../run-workspace-storage.ts";
import { startBootHeartbeat } from "../run-boot-heartbeat.ts";
import { runWithSpan, currentTraceparent, recordContainerSpawn } from "@appstrate/core/telemetry";

import { isMeteredByPlatformProxy, modelSourceOf } from "../state/runs.ts";
import { getEnv } from "@appstrate/env";
import { isBlockedEgressUrl } from "../../lib/egress-host-guard.ts";
import { getModelProvider } from "../model-providers/registry.ts";
import type { LlmProxyConfig, ModelSwap, SidecarLaunchSpec } from "@appstrate/core/sidecar-types";

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
 *
 * Derived from `RUN_BOOT_DEADLINE_SECONDS` rather than being a third
 * independent number: that env var IS the platform's answer to "how long may
 * provisioning take", and the watchdog refuses to keep a run alive past it.
 * A grace shorter than the deadline would let a boot the watchdog considers
 * legitimate eat into the agent's execution budget.
 */
function platformTimeoutBootGraceMs(): number {
  return getEnv().RUN_BOOT_DEADLINE_SECONDS * 1000;
}

/**
 * Thrown before provisioning when the model's base URL targets a network range
 * the sidecar's egress floor refuses (loopback, private, link-local, internal
 * names) and `EGRESS_ALLOW_INTERNAL_HOSTS` does not list its host.
 */
class LlmBaseUrlBlockedError extends Error {
  constructor(baseUrl: string) {
    const host = URL.parse(baseUrl)?.hostname ?? "(unparseable URL)";
    super(
      `The model's base URL targets a blocked network range (host "${host}"). Model ` +
        `inference goes through the run's sidecar, which reaches a private or local ` +
        `endpoint only when EGRESS_ALLOW_INTERNAL_HOSTS lists its host. Add "${host}" ` +
        `to EGRESS_ALLOW_INTERNAL_HOSTS, or point the model at a public endpoint.`,
    );
    this.name = "LlmBaseUrlBlockedError";
  }
}

/** Terminal state reported back to the caller once the container has exited. */
export interface PlatformContainerResult {
  /** Exit code reported by the orchestrator (0 = clean, non-zero = crash). */
  exitCode: number;
  /** Whether the agent container was stopped because the run timed out. */
  timedOut: boolean;
  /** Whether the run was cancelled by the caller's `AbortSignal`. */
  cancelled: boolean;
}

interface RunPlatformContainerInput {
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
   * run-workspace storage helper. The agent fetches the bundle itself at
   * startup; input files were already streamed into the workspace during
   * upload-consume. Tests substitute a capturing stub.
   */
  uploadBundle?: typeof uploadRunBundle;
  /**
   * Grace (ms) added to `plan.timeout` for the platform's safety-net
   * container watchdog. Defaults to {@link platformTimeoutBootGraceMs}.
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

  const { llmConfig } = plan;

  // Single source of truth for "what kind of credential is this and how is it
  // delivered". Classified by the provider's declared authMode: an oauth-class
  // credential is delivered via the sidecar `/llm` bearer-swap; everything
  // else is a static API-key placeholder substitution. Fail-closed: an OAuth
  // provider that resolved WITHOUT a stored credential id throws here (invalid
  // configuration — it must never downgrade to API-key handling, which would
  // hand the sidecar a token it cannot refresh).
  const delivery = resolveCredentialDelivery({
    providerId: llmConfig.providerId,
    credentialId: llmConfig.credentialId,
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
  // Stops the boot-phase liveness pump. Hoisted so the `finally` can retire
  // it on every exit path — the pump self-retires the instant the runner
  // posts its first event, so this only matters when provisioning failed or
  // the run ended without one.
  let stopBootHeartbeat: (() => void) | undefined;

  const spawnStart = Date.now();
  // Guards against double-recording the container-spawn histogram: the success
  // record fires before `waitForWorkload`, so a later execution failure (which
  // is NOT a spawn failure) must not also emit a spawn data point.
  let spawnRecorded = false;
  try {
    // Fail-closed BEFORE provisioning any isolation boundary: an OAuth run's
    // subscription credential sits with the sidecar, which only an isolating
    // orchestrator (docker, firecracker) keeps apart from the agent. API-key
    // providers are unaffected.
    assertOauthRunIsolation({
      isOauthCredential: delivery.kind === "oauth",
      providerId: llmConfig.providerId,
      orchestratorMode: getExecutionMode(),
    });
    // The oauth sidecar mode is a pure bearer-swap — it carries no modelSwap,
    // so an aliased subscription model can neither work nor stay masked.
    // Alias creation already rejects oauth credentials; fail-closed here for
    // any row predating that rule.
    assertOauthRunNotAliased({
      isOauthCredential: delivery.kind === "oauth",
      aliased: !!llmConfig.aliased,
      providerId: llmConfig.providerId,
    });

    const llmApiKey = llmConfig.apiKey;
    const servedByPlatformProxy = isMeteredByPlatformProxy({
      modelSource: modelSourceOf(llmConfig),
      modelId: llmConfig.aliasId,
    });

    // When the sidecar dials the base URL, its egress floor refuses a blocked
    // range. Same guard, same allowlist, checked here so the run fails with the
    // remedy instead of a 403 inside the container.
    if (!servedByPlatformProxy && isBlockedEgressUrl(llmConfig.baseUrl)) {
      throw new LlmBaseUrlBlockedError(llmConfig.baseUrl);
    }

    // Boot-phase liveness (see services/run-boot-heartbeat.ts). From here to
    // the runner's first event the platform — not the runner — owns this
    // run's liveness: it is pulling images, creating the boundary and
    // booting the container, and a cold image pull alone can outlast
    // RUN_STALL_THRESHOLD_SECONDS. Without this attestation the stall
    // watchdog kills the run mid-provision and blames a runner that never
    // got to exist. Started BEFORE the first orchestrator call so the whole
    // provisioning span is covered; bounded by `runs.boot_deadline_at`, so a
    // wedged daemon call still terminates the run (with an accurate error).
    stopBootHeartbeat = startBootHeartbeat({
      runId,
      intervalMs: getEnv().RUN_HEARTBEAT_INTERVAL_SECONDS * 1000,
      backend: "platform",
    });

    boundary = await orch.createIsolationBoundary(runId);

    // The placeholder is what actually lands in MODEL_API_KEY inside the
    // agent container. Provider-specific shape (e.g. a structured JWT) is
    // built by the module's `buildApiKeyPlaceholder` hook — see
    // `deriveOauthPlaceholder` below.
    const llmPlaceholder =
      delivery.kind === "oauth"
        ? deriveOauthPlaceholder(llmApiKey, llmConfig.providerId)
        : deriveKeyPlaceholder(llmApiKey);

    // Model-alias swap descriptor (LLM-gateway alias pattern). The container is
    // handed the public alias as MODEL_ID (below); the sidecar swaps it for the
    // real upstream id on every call. The real id never enters the container.
    const modelSwap: ModelSwap | undefined = llmConfig.aliased
      ? {
          alias: llmConfig.aliasId,
          real: llmConfig.modelId,
          // The container speaks the canonical dialect whatever the backing is:
          // it restricts this run's `/llm/*` surface to that dialect's one
          // endpoint, and tells the sidecar to terminate rather than proxy.
          clientApiShape: ALIAS_CLIENT_API_SHAPE,
          backingApiShape: llmConfig.apiShape,
          // What the sidecar rebuilds the backing's pi-ai Model from — Pi's
          // record, by its Pi provider key. Private to this channel — none of
          // it reaches `containerEnv` below.
          backing: {
            providerId: llmConfig.piProvider,
            ...(llmConfig.reasoning != null ? { reasoning: llmConfig.reasoning } : {}),
            input: llmConfig.input ?? ["text"],
          },
        }
      : undefined;

    // OAuth credentials must take the sidecar's OAuth branch — the API-key
    // path can't refresh tokens or inject the provider's identity routing
    // headers at request time. Narrowing `delivery` (rather than carrying a
    // boolean) is what supplies `credentialId` here: `resolveCredentialDelivery`
    // refused to build an `oauth` delivery without one, so there is nothing
    // left to re-assert at this point.
    //
    // OAuth subscription: the Pi SDK signs the subscription request shape
    // itself, so the sidecar just swaps the placeholder bearer for the real
    // token — no forging, no modelSwap (aliases rejected above).
    //
    // Platform-provided credential: spent only by the platform's metered LLM
    // proxy — the sidecar gets the route and authenticates with the run token,
    // and the key never leaves the API process.
    //
    // Org API key: the sidecar forwards directly to the upstream provider.
    // Transient 429/5xx are absorbed by two budgets, neither of them this
    // file's and neither restated here (one number, one place): the
    // container's turn-level retry policy in `packages/runner-pi/src/pi-runner.ts`,
    // and — for an ALIASED run, whose container never sees a `retry-after`
    // header — the sidecar's own provider-level budget in
    // `runtime-pi/sidecar/pi-messages-backend.ts`.
    const sidecarLlm: LlmProxyConfig =
      delivery.kind === "oauth"
        ? buildOauthSidecarLlm({ baseUrl: llmConfig.baseUrl, credentialId: delivery.credentialId })
        : servedByPlatformProxy
          ? {
              authMode: "platform",
              apiShape: llmConfig.apiShape,
              baseUrl: llmConfig.baseUrl,
              ...(modelSwap ? { modelSwap } : {}),
            }
          : {
              authMode: "api_key",
              baseUrl: llmConfig.baseUrl,
              apiKey: llmApiKey,
              placeholder: llmPlaceholder,
              ...(modelSwap ? { modelSwap } : {}),
            };

    // Agent↔sidecar bearer for THIS run. Minted here, in the one frame that
    // feeds both halves of the pair (`sidecarSpec` → the sidecar's env,
    // `buildRuntimePiEnv` → the agent container's), so the two can never be
    // set from different values. Never persisted, never logged, and never
    // handed to an integration runner — the sidecar keeps it in its config
    // object and builds runner env from the integration spec alone.
    //
    // Deliberately NOT `plan.runToken`, and not derived from it: the agent
    // container must stay unable to call the platform back (zero-knowledge),
    // so this secret carries no platform authority and no path to one.
    const sidecarAuthToken = randomBytes(32).toString("base64url");

    const sidecarSpec: SidecarLaunchSpec = {
      runToken: plan.runToken,
      sidecarAuthToken,
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
      // Platform runtime tools (output/log/note/pin) the sidecar
      // hosts as in-process MCP tools — unified with the integration tool
      // surface.
      ...(plan.runtimeTools && plan.runtimeTools.length > 0
        ? { runtimeTools: plan.runtimeTools }
        : {}),
    };

    const hasOutputSchema =
      plan.outputSchema?.properties && Object.keys(plan.outputSchema.properties).length > 0;
    // Forward the output schema to the sidecar so its `output` runtime tool
    // can constrain + validate the `data` argument.
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
        // The Pi key the container resolves Pi's record (dialect, limits) by.
        // MODEL_BASE_URL is the sidecar's, so without it every provider would
        // get plain-OpenAI bytes. An aliased
        // run needs no vendor key at all.
        piProvider: llmConfig.piProvider,
        apiKey: llmApiKey,
        apiKeyPlaceholder: llmPlaceholder,
        input: llmConfig.input,
        contextWindow: llmConfig.contextWindow,
        maxTokens: llmConfig.maxTokens,
        reasoning: llmConfig.reasoning,
        cost: llmConfig.cost,
        // WHAT this run is, not which vars to mask: `buildRuntimePiEnv` owns
        // the alias policy for the container env contract.
        aliased: !!llmConfig.aliased,
      },
      generation: plan.generationConfig,
      agentPrompt: prompt,
      runId,
      // Forward the execution budget so the runner enforces it itself, from the
      // run-loop start (boot excluded), and finalises a first-class `timeout`.
      // The platform setTimeout in `waitForWorkload` is the longer safety net.
      timeoutSeconds: plan.timeout,
      // All sidecar-relative URLs come from the boundary — the orchestrator
      // owns the topology (Docker DNS alias, host loopback port, in-guest
      // loopback for microVMs) and pi.ts stays backend-agnostic.
      sidecarUrl: boundary.sidecarEndpoints.sidecarUrl,
      // Other half of the pair minted above.
      sidecarAuthToken,
      // Inference rides the sidecar's `/llm` proxy, which swaps the
      // placeholder for the real credential upstream.
      sidecarProxyLlmUrl: boundary.sidecarEndpoints.llmProxyUrl,
      // Forward the effective per-file cap so the runtime's outputs
      // sweep agrees with the server-authoritative gate (avoids silently
      // skipping large deliverables when an operator raises the platform cap).
      maxFileBytes: getEnv().FILE_MAX_BYTES,
      modelRetry: getEnv().MODEL_RETRY_ENABLED,
      modelCompaction: getEnv().MODEL_COMPACTION_ENABLED,
      toolResultByteLimit: getEnv().TOOL_RESULT_BYTE_LIMIT,
      forwardProxyUrl: boundary.sidecarEndpoints.forwardProxyUrl,
      noProxy: boundary.sidecarEndpoints.noProxy,
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

    await orch.ensureImages([getEnv().PI_IMAGE, getEnv().SIDECAR_IMAGE]);

    // Sidecar + agent + bundle upload in parallel. The AFPS bundle is uploaded
    // to run-scoped storage; the agent container fetches and extracts it itself
    // at startup (`GET /api/runs/:runId/workspace`). Input files were
    // already streamed into the same run-workspace namespace during
    // upload-consume — the agent fetches each one (`GET
    // /api/runs/:runId/files/:name`) and streams it to disk, never buffering
    // the whole payload. This replaces the old seed-into-the-run-volume
    // delivery, whose correctness depended on the volume driver — a tmpfs-backed
    // `local` volume is NOT shared between the short-lived seed helper and the
    // agent container, so the bundle silently vanished and skills never
    // materialised (issue #549). With the agent self-provisioning, the run
    // volume is pure agent-local scratch again, so its backing (disk or tmpfs)
    // is a free performance choice. The upload must finish before
    // `startWorkload` (inside waitForWorkload) so the object exists when the
    // agent boots; racing it alongside the create calls here satisfies that
    // ordering.
    //
    // `allSettled`, NOT `all`. Two distinct leaks came out of `all`, and only
    // waiting for every branch closes both:
    //   - `all` rejects on the FIRST failure, so the `await` never returns and
    //     `sidecarHandle` / `agentHandle` are never assigned — the `finally`
    //     below then sees `undefined` and removes nothing. On Docker the agent
    //     container sits on `boundary.id`, so `removeIsolationBoundary`'s
    //     network + volume removals 409 on the still-attached container and are
    //     swallowed by its own `allSettled`: container, network AND volume all
    //     leak, holding `spec.env` — RUN_TOKEN, sink secret, model credentials,
    //     the sidecar auth token — readable via `docker inspect` forever
    //     (`cleanupOrphans()` runs only at boot).
    //   - `all` also resumes the caller while the slower branches are still in
    //     flight, so a container created AFTER a sibling's rejection is born
    //     orphaned — cleanup has already run.
    // Assignment therefore happens on the settled results, before the rethrow.
    //
    // `rejections` preserves WHICH failure the caller sees: `all` reported the
    // branch that failed first IN TIME, not the lowest index, and the catch
    // below plus the caller's error mapping have always keyed off that one.
    // Re-deriving it from array position would silently blame a different phase.
    const rejections: unknown[] = [];
    const track = <T>(p: Promise<T>): Promise<T> =>
      p.catch((err: unknown) => {
        rejections.push(err);
        throw err;
      });
    const [sidecarResult, agentResult, uploadResult] = await Promise.allSettled([
      track(orch.createSidecar(runId, boundary, sidecarSpec)),
      track(
        orch.createWorkload(
          {
            runId,
            role: "agent",
            image: getEnv().PI_IMAGE,
            env: containerEnv,
            resources: plan.resources.workload,
            // Hard host-side lifetime ceiling (B2): run budget + the same
            // boot grace the platform safety net uses + a 600 s margin, so
            // the daemon's kill is strictly a LAST resort behind the
            // safety-net setTimeout in waitForWorkload — it only ever fires
            // when the platform died or was partitioned mid-run and its own
            // stop can no longer reach the workload.
            maxLifetimeSeconds:
              plan.timeout +
              Math.ceil((input.timeoutBootGraceMs ?? platformTimeoutBootGraceMs()) / 1000) +
              600,
          },
          boundary,
        ),
      ),
      track(uploadBundle(runId, plan.agentPackage ?? undefined)),
    ]);
    // Reclaimable BEFORE the rethrow: whatever exists must reach the `finally`.
    if (sidecarResult.status === "fulfilled") sidecarHandle = sidecarResult.value;
    if (agentResult.status === "fulfilled") agentHandle = agentResult.value;
    if (
      sidecarResult.status === "rejected" ||
      agentResult.status === "rejected" ||
      uploadResult.status === "rejected"
    ) {
      throw rejections[0];
    }
    const sidecar = sidecarResult.value;
    const agent = agentResult.value;
    recordContainerSpawn(Date.now() - spawnStart);
    spawnRecorded = true;

    const lifecycle = await waitForWorkload(
      orch,
      agent,
      sidecar,
      plan.timeout,
      signal,
      input.timeoutBootGraceMs ?? platformTimeoutBootGraceMs(),
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
        errorType: boundary ? "workload" : "boundary",
      });
    }
    throw err;
  } finally {
    stopBootHeartbeat?.();
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
    // NOTHING drops the run workspace here. `finalizeRun` enqueues the bundle
    // + files-manifest deletion INSIDE its terminal CAS transaction
    // (run-event-ingestion.ts), and every path that tears this container down
    // converges there: the container's own `sink.finalize`, the synthesised
    // terminal `executeAgentInBackground` posts for each exit code / timeout /
    // orchestrator throw, the cancel route, the stall watchdog, and the boot
    // orphan sweep. Enqueuing again from this `finally` was the same two keys
    // with the same reason in a second, non-durable transaction — pure
    // duplicate work, and strictly weaker than the transactional one, which
    // survives a SIGKILL between the terminal write and this teardown.
  }
}

/**
 * Drive the agent container lifecycle: start, enforce the SAFETY-NET timeout
 * (`timeoutSeconds` + {@link platformTimeoutBootGraceMs} — the runner owns
 * the primary, boot-excluded budget), propagate cancellation, wait for exit.
 * Sidecar is stopped alongside the agent on any terminal condition so neither
 * lingers after the run has ended.
 */
async function waitForWorkload(
  orch: RunOrchestrator,
  agent: WorkloadHandle,
  sidecar: WorkloadHandle,
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
      orch.stopWorkload(sidecar).catch(() => {});
    },
    timeoutSeconds * 1000 + bootGraceMs,
  );

  const onAbort = () => {
    orch.stopWorkload(agent).catch(() => {});
    orch.stopWorkload(sidecar).catch(() => {});
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    const agentExit = orch.waitForExit(agent);
    const sidecarDeath = await firstUnexpectedSidecarExit(
      observeSidecarExit(orch, sidecar),
      agentExit,
      () => timedOut || (signal?.aborted ?? false),
    );
    if (sidecarDeath !== null) {
      // Nothing the agent does from here can succeed: its tools, model proxy
      // and forward proxy all sat behind the sidecar. Stop it rather than let
      // it wait out its MCP handshake deadline, then fail on the real cause.
      orch.stopWorkload(agent).catch(() => {});
      await Promise.all([agentExit.catch(() => {}), logSidecarCrash(orch, sidecar, sidecarDeath)]);
      throw new Error(
        `Sidecar exited with code ${sidecarDeath} while the run was in progress; the agent was stopped`,
      );
    }
    const exitCode = await agentExit;
    if (exitCode !== 0 && !timedOut && !signal?.aborted) {
      // A sidecar crash can take the agent down in the same poll round, and
      // the agent's exit may win the race: report the sidecar's too.
      const code = await exitedSidecarCode(orch, sidecar);
      if (code !== undefined && code !== 0) await logSidecarCrash(orch, sidecar, code);
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
 * The sidecar's exit, on an orchestrator that observes it on its own
 * ({@link RunOrchestrator.sidecarExitsIndependently}); `null` otherwise. A
 * wait that rejects (container gone, daemon error) says nothing about how the
 * sidecar ended, so it never settles.
 */
function observeSidecarExit(
  orch: RunOrchestrator,
  sidecar: WorkloadHandle,
): Promise<number> | null {
  if (!orch.sidecarExitsIndependently) return null;
  return orch.waitForExit(sidecar).catch(() => new Promise<never>(() => {}));
}

/**
 * Resolve with the sidecar's exit code if it exits before the agent does and
 * the platform did not ask for it (timeout, cancel); `null` once the agent
 * exits first, or always when the sidecar is not observed.
 */
async function firstUnexpectedSidecarExit(
  sidecarExit: Promise<number> | null,
  agentExit: Promise<number>,
  stopRequested: () => boolean,
): Promise<number | null> {
  const agentDone = agentExit.then(
    () => null,
    () => null,
  );
  if (!sidecarExit) return agentDone;
  const first = await Promise.race([agentDone, sidecarExit]);
  if (first === null || stopRequested()) return agentDone;
  return first;
}

const SIDECAR_TAIL_LINES = 30;
const SIDECAR_TAIL_TIMEOUT_MS = 2_000;
// Bounds one immediate exit check (a local Docker inspect); waiting longer
// would delay every failed run and catch stops issued after the agent's exit.
const SIDECAR_EXIT_PROBE_MS = 250;

/**
 * The sidecar's exit code if it has already exited, `undefined` otherwise. A
 * fresh wait answers at once (Docker inspects before its first backoff, a
 * process's `exited` is already settled), where the in-flight one can be a
 * whole poll behind.
 */
async function exitedSidecarCode(
  orch: RunOrchestrator,
  sidecar: WorkloadHandle,
): Promise<number | undefined> {
  const exit = observeSidecarExit(orch, sidecar);
  return exit ? withTimeout(exit, SIDECAR_EXIT_PROBE_MS) : undefined;
}

/** `promise`'s value, or `undefined` once `ms` elapse first. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function logSidecarCrash(
  orch: RunOrchestrator,
  sidecar: WorkloadHandle,
  exitCode: number,
): Promise<void> {
  const tail = await readLogTail(orch, sidecar);
  logger.error("Sidecar exited while the run was in progress", {
    runId: sidecar.runId,
    exitCode,
    ...(tail ? { tail } : {}),
  });
}

/**
 * Last lines of an exited workload's logs, for the crash report. Bounded in
 * time whatever the orchestrator does with the signal (Docker's only checks
 * it once the response arrives); best-effort, so a log read failure never
 * masks the exit itself.
 */
async function readLogTail(orch: RunOrchestrator, handle: WorkloadHandle): Promise<string> {
  const abort = new AbortController();
  const lines: string[] = [];
  const read = (async () => {
    try {
      for await (const line of orch.streamLogs(handle, abort.signal)) {
        lines.push(line);
        if (lines.length > SIDECAR_TAIL_LINES) lines.shift();
      }
    } catch {
      // Diagnostics only.
    }
  })();
  await withTimeout(read, SIDECAR_TAIL_TIMEOUT_MS);
  abort.abort();
  return lines.join("\n");
}

/** Leading dash-separated segments a placeholder may keep. */
const PLACEHOLDER_PREFIX_SEGMENTS = 2;

/**
 * Derive a placeholder that preserves the key's dash-separated prefix, so the
 * SDK's prefix-based behavior (OAuth detection, auth header format, beta
 * headers) works identically with the placeholder.
 *
 * Bounded on both axes, because the original rule — drop the LAST segment,
 * keep everything before it — did not bound what it keeps. A key body is
 * base64url, whose alphabet contains `-`, so `sk-ant-api03-AbC-dEf-XyZ` kept
 * `sk-ant-api03-AbC-dEf`: real secret material placed inside the agent
 * container. Two segments is what prefix sniffing actually reads (`sk-ant-`,
 * `sk-proj-`, `sk-or-`), and the half-length ceiling keeps a short key from
 * handing over most of itself.
 *
 * This still names the VENDOR, which is correct here and only here: on a
 * non-aliased run the container is told the provider outright via
 * `MODEL_PROVIDER`. An aliased run never reaches this value — see
 * `ALIAS_API_KEY_PLACEHOLDER` in `@appstrate/runner-pi`.
 */
function deriveKeyPlaceholder(key: string): string {
  const parts = key.split("-");
  const kept = parts.slice(0, Math.min(PLACEHOLDER_PREFIX_SEGMENTS, parts.length - 1)).join("-");
  const ceiling = Math.floor(key.length / 2);
  const bounded = kept.length > ceiling ? kept.slice(0, ceiling) : kept;
  const placeholder = bounded ? `${bounded}-placeholder` : "sk-placeholder";
  // A key already shaped like its placeholder still gets a different value.
  return placeholder === key ? `${placeholder}-0` : placeholder;
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
function deriveOauthPlaceholder(key: string, providerId: string): string {
  const config = getModelProvider(providerId);
  const fromHook = config?.hooks?.buildApiKeyPlaceholder?.(key);
  return fromHook ?? deriveKeyPlaceholder(key);
}

/** @internal Exported for testing */
export {
  deriveKeyPlaceholder as _deriveKeyPlaceholderForTesting,
  deriveOauthPlaceholder as _deriveOauthPlaceholderForTesting,
};
